import { SemanticTokensBuilder, SemanticTokens, SemanticTokensLegend } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

// The compiler repo's highlight.js is the single source of truth for
// "which grammar node maps to which token class" -- the CodeMirror editor and
// the docs renderer already consume it, and now so does the language server.
// highlightSegments(code, "icc") returns contiguous `{ text, class }` runs
// (class is null for the whitespace/gaps between styled tokens).
import type { FileHandler } from "ic10-compiler/compiler/index.ts";
import { highlightSegments } from "ic10-compiler/highlight.js";
import { getAST } from "ic10-compiler/compiler/ast.ts";
import { analyzeScopes, type ScopeAnalysis } from "ic10-compiler/compiler/scope.ts";

/**
 * Maps each `tok-*` class emitted by highlight.js to an LSP semantic token
 * type (and optional modifiers). Only standard token types are used, so every
 * theme colours them out of the box with no manifest or theme configuration.
 *
 * A few ICC categories have no exact standard equivalent, so they borrow the
 * closest one that still renders as a distinct colour:
 *   - instruction -> macro       (assembly-op feel, distinct from function)
 *   - register    -> parameter   (distinct slot colour)
 *   - device      -> variable + defaultLibrary (built-in, themes tint it)
 *   - label       -> function    (matches the editor, which shares tok-function)
 *
 * `declarationKeyword` is the one non-standard type. `let`/`const`/`define` are
 * storage keywords, and no standard semantic type resolves to a `storage.*`
 * TextMate scope -- `keyword` resolves to `keyword.control`, which is the
 * control-flow colour (#C586C0 in Dark+), not the storage colour (#569CD6).
 * Modifiers cannot bridge the gap either: VS Code registers every token
 * modifier with no probe scopes, so a modifier only ever does anything when a
 * theme names it explicitly, and the built-in themes never do. The type is
 * therefore declared in the manifest's `semanticTokenTypes` and pointed at
 * `storage.type` via `semanticTokenScopes`, with `keyword` as its superType so
 * exotic themes still get a sane fallback.
 */
const CLASS_MAP: Record<string, { type: string; modifiers?: string[] }> = {
  "tok-keyword": { type: "keyword" },
  "tok-declaration": { type: "declarationKeyword" },
  "tok-comment": { type: "comment" },
  "tok-string": { type: "string" },
  "tok-number": { type: "number" },
  "tok-bool": { type: "bool" },
  "tok-variable": { type: "variable" },
  "tok-function": { type: "function" },
  "tok-operator": { type: "operator" },
  "tok-instruction": { type: "macro" },
  "tok-register": { type: "type" },
  "tok-device": { type: "type" },
  "tok-label": { type: "function" },
};

// Legend order defines the numeric ids the server sends on the wire; the client
// resolves them back to names via the legend advertised at initialize time.
export const tokenTypes: string[] = [...new Set(Object.values(CLASS_MAP).map((m) => m.type))];
// `readonly` is applied by scope analysis (const/define), on top of any static
// modifiers a class carries.
export const tokenModifiers: string[] = [
  ...new Set([...Object.values(CLASS_MAP).flatMap((m) => m.modifiers ?? []), "readonly"]),
];

export const legend: SemanticTokensLegend = { tokenTypes, tokenModifiers };

const typeIndex = new Map(tokenTypes.map((t, i) => [t, i]));
const modifierBit = new Map(tokenModifiers.map((m, i) => [m, 1 << i]));

/** Pick the mapping for a (possibly space-joined) class string. */
function mappingFor(classes: string): { type: string; modifiers?: string[] } | undefined {
  for (const cls of classes.split(/\s+/)) {
    const mapping = CLASS_MAP[cls];
    if (mapping) return mapping;
  }
  return undefined;
}

/** Only identifier tokens carry scope meaning (const-ness, declaredness). */
const IDENTIFIER_CLASS = /\btok-(variable|function)\b/;

/** Scope analysis, or undefined when the source doesn't parse (mid-edit). */
function tryAnalyzeScopes(text: string, fileHandler?: FileHandler): ScopeAnalysis | undefined {
  try {
    return analyzeScopes(getAST(text), fileHandler);
  } catch {
    return undefined;
  }
}

/**
 * Produce the semantic tokens for a whole document by re-highlighting it with
 * the shared parser and translating the coloured runs into LSP tokens.
 *
 * On top of the lexical colouring, scope analysis refines identifier tokens:
 * `const`/`define` names get the `readonly` modifier, and identifiers that
 * resolve to nothing are left unhighlighted (no token emitted). When the source
 * doesn't parse, that refinement is skipped and plain colouring stands.
 *
 * A single semantic token may not span a line break, so any run containing a
 * newline (e.g. a multi-line string) is split into one token per line.
 */
export function buildSemanticTokens(doc: TextDocument, fileHandler?: FileHandler): SemanticTokens {
  const text = doc.getText();
  const analysis = tryAnalyzeScopes(text, fileHandler);
  const builder = new SemanticTokensBuilder();
  let offset = 0;

  for (const segment of highlightSegments(text, "icc")) {
    const runLength = segment.text.length;
    const mapping = segment.class ? mappingFor(segment.class) : undefined;

    if (mapping) {
      const isIdentifier = analysis !== undefined && IDENTIFIER_CLASS.test(segment.class!);
      const hint = isIdentifier ? analysis!.hintAt(offset) : undefined;

      if (hint !== "undeclared") {
        const typeId = typeIndex.get(mapping.type)!;
        let modifiers = 0;
        for (const m of mapping.modifiers ?? []) modifiers |= modifierBit.get(m) ?? 0;
        if (hint === "readonly") modifiers |= modifierBit.get("readonly") ?? 0;

        let lineOffset = offset;
        for (const linePiece of segment.text.split("\n")) {
          if (linePiece.length > 0) {
            const pos = doc.positionAt(lineOffset);
            builder.push(pos.line, pos.character, linePiece.length, typeId, modifiers);
          }
          lineOffset += linePiece.length + 1; // + 1 for the consumed "\n"
        }
      }
      // hint === "undeclared": emit nothing, leaving the identifier uncoloured.
    }

    offset += runLength;
  }

  return builder.build();
}

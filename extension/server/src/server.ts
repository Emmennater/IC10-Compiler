import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
  Location,
  Range,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

// The single source of truth for this language's syntax and semantics. The
// server reuses the exact parse + compile path the CodeMirror editor uses
// (see IC10-Compiler/main.js), so diagnostics can never drift between editors.
import { getAST } from "ic10-compiler/compiler/ast.ts";
import { compile, diagnose, CompileError } from "ic10-compiler/compiler/index.ts";
import { getCompletions } from "ic10-compiler/compiler/completions.ts";
import { analyzeScopes, type ScopeAnalysis, type Sym } from "ic10-compiler/compiler/scope.ts";

import { legend, buildSemanticTokens } from "./semantic-tokens.ts";
import { makeFileHandler, resolveModule } from "./file-handler.ts";
import { toCompletionItems } from "./completion.ts";
import type { FileHandler } from "ic10-compiler/compiler/index.ts";

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((_params: InitializeParams) => {
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Highlighting is computed from the shared parser rather than a TextMate
      // grammar, so it can never drift from the editor and can grow to depend
      // on more than the raw token (scope, declarations) later.
      semanticTokensProvider: {
        legend,
        full: true,
      },
      completionProvider: {
        resolveProvider: false,
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: {
        prepareProvider: true,
      },
    },
  };

  return result;
});

documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});

/** The compiler's import resolver for a document, over the open workspace. */
function fileHandlerFor(document: TextDocument): FileHandler {
  return makeFileHandler(document.uri, documents.all());
}

/**
 * Scope analysis for a document. `analyzeScopes` converts leniently, so this
 * answers over half-typed source too -- the statements that do not parse are
 * simply absent from the tree it walked. The guard is for a fault in the
 * analysis itself, which must not take a hover or a rename down with it.
 */
function analysisFor(document: TextDocument): ScopeAnalysis | undefined {
  try {
    return analyzeScopes(getAST(document.getText()), fileHandlerFor(document));
  } catch {
    return undefined;
  }
}

/** A compiler source range (char offsets) as an LSP range (line/character). */
function toLspRange(document: TextDocument, range: { from: number; to: number }): Range {
  return { start: document.positionAt(range.from), end: document.positionAt(range.to) };
}

// Scope-aware completion: in-scope names at the cursor, plus keywords. The
// resolution lives in the shared compiler (completions.ts / scope.ts); this
// only supplies the offset + import resolver and maps kinds to LSP items.
connection.onCompletion((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const offset = document.offsetAt(params.position);
  return toCompletionItems(
    getCompletions(getAST(document.getText()), offset, fileHandlerFor(document)),
  );
});

/**
 * Parse and compile a document, resolving any `import`s against the workspace.
 * Shared by diagnostics (which only care whether it throws) and the run command
 * (which wants the assembly). `removeLabels` produces the paste-ready form.
 */
function compileDocument(document: TextDocument, removeLabels: boolean): string {
  const ast = getAST(document.getText());
  return compile(ast, { removeLabels }, fileHandlerFor(document));
}

// Full-document semantic highlighting. VS Code re-requests this on edits; the
// parser is fast enough to re-highlight the whole document each time.
connection.languages.semanticTokens.on((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return { data: [] };
  return buildSemanticTokens(document, fileHandlerFor(document));
});

// Hover: describe the symbol under the cursor.
connection.onHover((params): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const analysis = analysisFor(document);
  if (!analysis) return null;
  const occurrence = analysis.occurrenceAt(document.offsetAt(params.position));
  if (!occurrence || !occurrence.symbol) return null;

  return {
    contents: { kind: "markdown", value: describeSymbol(occurrence.symbol) },
    range: toLspRange(document, occurrence.range),
  };
});

// Go-to-definition: jump to the binding site, crossing into the module for an
// imported name.
connection.onDefinition((params): Location | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const analysis = analysisFor(document);
  if (!analysis) return null;
  const occurrence = analysis.occurrenceAt(document.offsetAt(params.position));
  if (!occurrence || !occurrence.symbol) return null;
  const symbol = occurrence.symbol;

  if (symbol.origin) {
    const module = resolveModule(document.uri, symbol.origin.modulePath, documents.all());
    if (!module) return null;
    // A throwaway document just to map the module's offsets to line/character.
    const moduleDoc = TextDocument.create(module.uri, "icc", 0, module.text);
    return Location.create(module.uri, toLspRange(moduleDoc, symbol.origin.range));
  }
  return Location.create(document.uri, toLspRange(document, symbol.declRange));
});

// Rename: restricted to same-file symbols. An imported name has no local
// binding to rename safely (there is no import alias syntax), and undeclared /
// non-identifier positions are not renameable.
connection.onPrepareRename((params): Range | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const analysis = analysisFor(document);
  if (!analysis) return null;
  const occurrence = analysis.occurrenceAt(document.offsetAt(params.position));
  if (!occurrence || !occurrence.symbol || occurrence.symbol.origin) return null;
  return toLspRange(document, occurrence.range);
});

connection.onRenameRequest((params): WorkspaceEdit | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const analysis = analysisFor(document);
  if (!analysis) return null;
  const occurrence = analysis.occurrenceAt(document.offsetAt(params.position));
  if (!occurrence || !occurrence.symbol || occurrence.symbol.origin) return null;
  if (!/^[A-Za-z_]\w*$/.test(params.newName)) return null;

  const edits = analysis
    .occurrencesOf(occurrence.symbol)
    .map((o) => TextEdit.replace(toLspRange(document, o.range), params.newName));
  return { changes: { [document.uri]: edits } };
});

// Find-all-references: every occurrence of the symbol in this file. References
// are not indexed across files, so imported names report only their local uses.
connection.onReferences((params): Location[] | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  const analysis = analysisFor(document);
  if (!analysis) return null;
  const occurrence = analysis.occurrenceAt(document.offsetAt(params.position));
  if (!occurrence || !occurrence.symbol) return null;
  const symbol = occurrence.symbol;

  return analysis
    .occurrencesOf(symbol)
    .filter((o) => params.context.includeDeclaration || o.range.from !== symbol.declRange.from)
    .map((o) => Location.create(document.uri, toLspRange(document, o.range)));
});

/** Hover: the declaration snippet, in an `icc` fence so the grammar colours it. */
function describeSymbol(symbol: Sym): string {
  const fence = "```icc\n" + symbol.signature + "\n```";
  return symbol.origin ? `${fence}\n\nImported from \`${symbol.origin.modulePath}\`` : fence;
}

/** Result of an `icc/compile` request: the assembly, or why it failed. */
type CompileResult =
  | { ok: true; ic10: string }
  | { ok: false; message: string };

// Compile-on-demand, driven by the client's run command. Compilation lives on
// the server so the client never imports the compiler -- the same reason
// diagnostics and highlighting do. `removeLabels` matches the web editor's
// output: labels resolved to absolute line numbers, ready to paste in-game.
connection.onRequest("icc/compile", ({ uri }: { uri: string }): CompileResult => {
  const document = documents.get(uri);
  if (!document) {
    return { ok: false, message: "Document is not open on the language server." };
  }
  try {
    const ic10 = compileDocument(document, true);
    return { ok: true, ic10 };
  } catch (error) {
    const message =
      error instanceof CompileError
        ? error.message
        : `Internal compiler error: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, message };
  }
});

/**
 * Run the compiler over the document and publish everything it complains about.
 *
 * All the language knowledge lives in the compiler; this function's only job
 * is to translate between the compiler's world (character offsets on a
 * `CompileError`) and LSP's world (line/character ranges), which
 * `TextDocument.positionAt` does directly.
 *
 * `diagnose` is the compiler's collecting entry point -- unlike `compile` it
 * recovers past an error where recovery is honest (per statement while parsing,
 * per top-level statement while lowering), so a file with several mistakes
 * underlines all of them rather than one per save. It returns the errors
 * instead of throwing; a throw out of it is a fault in the compiler, and still
 * gets surfaced rather than swallowed.
 */
function validateTextDocument(textDocument: TextDocument): void {
  const diagnostics: Diagnostic[] = [];

  try {
    // Diagnostics only; no assembly is produced or wanted, which is why
    // `removeLabels` has no counterpart here. Imports resolve through the
    // workspace file handler, so errors inside imported modules surface too.
    const errors = diagnose(getAST(textDocument.getText()), {}, fileHandlerFor(textDocument));
    for (const error of errors) diagnostics.push(toDiagnostic(error, textDocument));
  } catch (error) {
    diagnostics.push(toDiagnostic(error, textDocument));
  }

  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

/**
 * Convert a thrown value into an LSP diagnostic. A `CompileError` carries the
 * offending source range; anything else is an unexpected compiler fault, which
 * we still surface (anchored at the document start) rather than swallow, so the
 * user sees that something went wrong instead of getting silent no-ops.
 */
function toDiagnostic(error: unknown, doc: TextDocument): Diagnostic {
  if (error instanceof CompileError) {
    return {
      severity: DiagnosticSeverity.Error,
      range: {
        start: doc.positionAt(error.from),
        end: doc.positionAt(error.to),
      },
      message: error.message,
      source: "ic10",
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    severity: DiagnosticSeverity.Error,
    range: { start: doc.positionAt(0), end: doc.positionAt(0) },
    message: `Internal compiler error: ${message}`,
    source: "ic10",
  };
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

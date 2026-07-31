/**
 * Editor completions, computed from the parse tree. Framework-agnostic on
 * purpose: it returns plain `{ label, kind }` records with no dependency on any
 * editor's API, so the VS Code language server and CodeMirror both call it and
 * map the result onto their own completion item types.
 */

import type { SyntaxNode } from "./ast.ts";
import { analyzeScopes, type SymbolKind } from "./scope.ts";
import type { FileHandler } from "./modules.ts";

export type CompletionKind = SymbolKind | "keyword";

export type Completion = { label: string; kind: CompletionKind };

/**
 * The language's keywords, from the grammar's `kw<...>` / `kw_<...>` tokens
 * (lezer/lang.grammar). Lives here so every editor offers the same set.
 */
export const KEYWORDS: readonly string[] = [
  // storage / declarations
  "let", "const", "constexpr", "define", "device", "stack",
  // control flow
  "if", "then", "elif", "else", "end",
  "loop", "while", "do", "repeat", "until",
  "for", "in", "of",
  "break", "continue", "return",
  // functions and modules
  "fn", "import", "from", "using",
  // built-in statements
  "yield", "sleep",
  // boolean literals
  "true", "false",
];

const KEYWORD_COMPLETIONS: Completion[] = KEYWORDS.map((label) => ({ label, kind: "keyword" }));

/**
 * Completions offered at `offset`: the names in scope there, then the keywords.
 * On unparseable source (common mid-edit) the scope pass throws, and we fall
 * back to keywords alone rather than offering nothing.
 */
export function getCompletions(
  ast: SyntaxNode,
  offset: number,
  fileHandler?: FileHandler,
): Completion[] {
  let symbols: Completion[] = [];
  try {
    symbols = analyzeScopes(ast, fileHandler)
      .symbolsAt(offset)
      .map((s) => ({ label: s.name, kind: s.kind }));
  } catch {
    // Half-typed program: keywords only.
  }
  return [...symbols, ...KEYWORD_COMPLETIONS];
}

import { CompletionItem, CompletionItemKind } from "vscode-languageserver/node";
import type { Completion, CompletionKind } from "ic10-compiler/compiler/completions.ts";

// The keyword list and scope analysis live in the compiler (completions.ts /
// scope.ts) so both editors share them. This file only translates the shared,
// framework-agnostic result into LSP completion items.
const KIND_MAP: Record<CompletionKind, CompletionItemKind> = {
  keyword: CompletionItemKind.Keyword,
  var: CompletionItemKind.Variable,
  const: CompletionItemKind.Constant,
  define: CompletionItemKind.Constant,
  device: CompletionItemKind.Variable,
  function: CompletionItemKind.Function,
  param: CompletionItemKind.Variable,
  list: CompletionItemKind.Variable,
  stackvar: CompletionItemKind.Variable,
  import: CompletionItemKind.Variable,
};

export function toCompletionItems(completions: Completion[]): CompletionItem[] {
  return completions.map((c) => ({ label: c.label, kind: KIND_MAP[c.kind] }));
}

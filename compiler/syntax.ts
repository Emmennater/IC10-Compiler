/**
 * Parse-tree types, diagnostics, and the little that still reads the raw
 * concrete syntax tree.
 *
 * The Lezer tree keeps every keyword and punctuation token, and inlines
 * blocks into their container. Only `formal-ast.ts` interprets that shape;
 * everything downstream of it works on the typed tree instead, so the
 * navigation helpers that used to live here (`blockOf`, `conditionOf`,
 * `statementsIn`) moved there with it.
 *
 * `SyntaxNode` and `CompileError` are defined in ast.ts (next to the actual
 * Lezer parser that produces them) and re-exported here so the rest of the
 * pipeline keeps importing them from "./syntax" as before.
 */

import { CompileError, type SourceRange, type SyntaxNode } from "./ast.ts";

export { CompileError };
export type { SourceRange, SyntaxNode };

/**
 * Creates CompileErrors whose messages carry the 0-based source line
 * (the editor gutter is 0-based, so error lines are too). Line starts are
 * precomputed once so each lookup is a binary search, not a source scan.
 */
export class ErrorReporter {
  private readonly lineStarts: number[];
  private readonly sourceLength: number;

  constructor(source: string) {
    this.sourceLength = source.length;
    this.lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\n") this.lineStarts.push(i + 1);
    }
  }

  /** The 0-based line containing the node's start position. */
  lineOf(node: SourceRange): number {
    const position = Math.min(node.from, this.sourceLength);
    // Rightmost line start at or before `position`
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid] <= position) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  error(message: string, node: SourceRange): CompileError {
    return new CompileError(`Line ${this.lineOf(node)}: ${message}`, node);
  }
}

/** Node types that can appear where an expression is expected. */
export const EXPRESSION_TYPES: ReadonlySet<string> = new Set([
  "Number", "Bool", "VariableName", "Device", "DeviceProperty", "DeviceChannelProperty",
  "DeviceNameProperty", "Parens", "UnaryOp", "BinaryOp", "TernaryOp", "FunctionCall", "String",
  "Value", "Integer",
]);

/** Node types that can appear where a statement is expected. */
export const STATEMENT_TYPES: ReadonlySet<string> = new Set([
  "Declaration", "Assignment", "IfExpr", "LoopExpr", "WhileExpr", "RepeatUntilExpr",
  "break", "continue", "Instruction", "FunctionCall", "DeviceDeclaration", "Definition",
  "FunctionDef", "Return", "PreprocessorDirective", "ArrayDeclaration", "ForExpr",
  "ForInExpr", "ForOfExpr", "Import", "StackDeclaration",
]);

/** Children minus comments, which are skipped tokens attachable anywhere. */
export function kids(node: SyntaxNode): SyntaxNode[] {
  return node.children.filter(c => c.type !== "Comment");
}

/** The first parse-error node ("⚠") in a subtree, in document order. */
export function firstSyntaxError(node: SyntaxNode): SyntaxNode | undefined {
  if (node.type === "⚠") return node;
  for (const child of node.children) {
    const found = firstSyntaxError(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * Every parse-error node in a subtree, in document order. The recovering
 * conversion reports all of them; `checkSyntax` stops at the first, which is
 * all `compile()` can act on.
 */
export function syntaxErrorNodes(node: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  // An error node's own children are the tokens it swallowed, so reporting the
  // outermost one is one diagnostic per broken span rather than per token.
  const visit = (n: SyntaxNode): void => {
    if (n.type === "⚠") { found.push(n); return; }
    for (const child of n.children) visit(child);
  };
  visit(node);
  return found;
}

/** Reject any parse-error node (the grammar marks them with "⚠"). */
export function checkSyntax(node: SyntaxNode, errors: ErrorReporter): void {
  const bad = firstSyntaxError(node);
  if (bad) throw errors.error("Syntax error", bad);
}


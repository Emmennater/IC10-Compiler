/**
 * Parse-tree types and AST navigation helpers.
 *
 * The compiler consumes a Lezer-style concrete syntax tree: every node
 * carries its type name, source text, source range, and children (including
 * keyword and punctuation tokens). The helpers here are the only place that
 * knows how statements, conditions, and blocks are laid out inside a node.
 *
 * `SyntaxNode` and `CompileError` are defined in ast.ts (next to the actual
 * Lezer parser that produces them) and re-exported here so the rest of the
 * pipeline keeps importing them from "./syntax" as before.
 */

import { CompileError, type SyntaxNode } from "./ast.ts";

export { CompileError };
export type { SyntaxNode };

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
  lineOf(node: SyntaxNode): number {
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

  error(message: string, node: SyntaxNode): CompileError {
    return new CompileError(`Line ${this.lineOf(node)}: ${message}`, node);
  }
}

/** Node types that can appear where an expression is expected. */
export const EXPRESSION_TYPES: ReadonlySet<string> = new Set([
  "Number", "Bool", "VariableName", "Device", "DeviceProperty", "DeviceChannelProperty",
  "DeviceNameProperty", "Parens", "UnaryOp", "BinaryOp", "FunctionCall", "String",
]);

/** Node types that can appear where a statement is expected. */
export const STATEMENT_TYPES: ReadonlySet<string> = new Set([
  "Declaration", "Assignment", "IfExpr", "LoopExpr", "WhileExpr", "RepeatUntilExpr",
  "break", "continue", "Instruction", "FunctionCall", "DeviceDeclaration", "Definition",
  "FunctionDef", "Return", "PreprocessorDirective",
]);

/** Children minus comments, which are skipped tokens attachable anywhere. */
export function kids(node: SyntaxNode): SyntaxNode[] {
  return node.children.filter(c => c.type !== "Comment");
}

/** Reject any parse-error node (the grammar marks them with "⚠"). */
export function checkSyntax(node: SyntaxNode, errors: ErrorReporter): void {
  if (node.type === "⚠") {
    throw errors.error("Syntax error", node);
  }
  for (const child of node.children) checkSyntax(child, errors);
}

/** Statement children between two keyword tokens (either side optional). */
export function statementsIn(
  node: SyntaxNode,
  afterKeyword: string | null,
  beforeKeyword: string | null,
): SyntaxNode[] {
  const parts = kids(node);
  let start = 0;
  let end = parts.length;
  if (afterKeyword) {
    const i = parts.findIndex(c => c.type === afterKeyword);
    if (i >= 0) start = i + 1;
  }
  if (beforeKeyword) {
    const i = parts.findIndex(c => c.type === beforeKeyword);
    if (i >= 0) end = i;
  }
  return parts.slice(start, end).filter(c => STATEMENT_TYPES.has(c.type));
}

/**
 * The statement body of a construct. Function calls are both statements
 * and expressions, so bodies are delimited by keywords, not by node type.
 */
export function blockOf(node: SyntaxNode): SyntaxNode[] {
  switch (node.type) {
    case "If":
    case "ElseIf":
      return statementsIn(node, "then", null);
    case "WhileExpr":
      return statementsIn(node, "do", null);
    case "RepeatUntilExpr":
      return statementsIn(node, "repeat", "until");
    default: // Else, LoopExpr
      return statementsIn(node, null, null);
  }
}

/** The condition expression of an if/elif/while/repeat construct. */
export function conditionOf(node: SyntaxNode): SyntaxNode | null {
  const parts = kids(node);
  if (node.type === "RepeatUntilExpr") {
    const i = parts.findIndex(c => c.type === "until");
    return parts.slice(i + 1).find(c => EXPRESSION_TYPES.has(c.type)) ?? null;
  }
  const boundary = node.type === "WhileExpr" ? "do" : "then";
  const i = parts.findIndex(c => c.type === boundary);
  return parts.slice(0, i < 0 ? parts.length : i).find(c => EXPRESSION_TYPES.has(c.type)) ?? null;
}

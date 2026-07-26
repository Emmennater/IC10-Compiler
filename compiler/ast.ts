import { parser } from "../lezer/parser.ts";
import type { TreeCursor } from "@lezer/common";

/** One node of the parse tree produced by the language grammar. */
export type SyntaxNode = {
  type: string;
  text: string;
  from: number;
  to: number;
  children: SyntaxNode[];
};

/** A compile-time diagnostic carrying the offending source range. */
export class CompileError extends Error {
  readonly from: number;
  readonly to: number;

  constructor(message: string, node: SyntaxNode) {
    super(message);
    this.name = "CompileError";
    this.from = node.from;
    this.to = node.to;
  }
}

function nodeToJSON(cursor: TreeCursor, text: string): SyntaxNode {
  const result = {
    type: cursor.type.name as string,
    text: text.substring(cursor.from, cursor.to) as string,
    from: cursor.from as number,
    to: cursor.to as number,
    children: [] as SyntaxNode[],
  };

  if (cursor.firstChild()) {
    do {
      result.children.push(nodeToJSON(cursor, text));
    } while (cursor.nextSibling());
    cursor.parent();
  }

  return result;
}

export function getAST(text: string): SyntaxNode {
  const tree = parser.parse(text);
  const ast = nodeToJSON(tree.cursor(), text);
  return ast;
}
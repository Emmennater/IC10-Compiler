/**
 * Parses source text with the frozen pre-Value grammar (lang-original.grammar),
 * producing the exact node shapes tests/original.ts
 * expect (DeviceProperty/DeviceChannelProperty/DeviceNameProperty, bare
 * VariableName/Device in expression position). Mirrors compiler/ast.ts's
 * getAST, but against the separately generated parser-original.js so the
 * differential suite can feed each compiler the shape it understands.
 */

import { parser } from "../lezer/parser-original.js";
import type { TreeCursor } from "@lezer/common";
import type { SyntaxNode } from "../compiler/syntax.ts";

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

export function getOriginalAST(text: string): SyntaxNode {
  const tree = parser.parse(text);
  return nodeToJSON(tree.cursor(), text);
}

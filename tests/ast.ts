/** Generic synthetic-node builders used directly by leaf-library unit tests. */

import type { SyntaxNode } from "../compiler/syntax.ts";

export function node(type: string, text: string, ...children: SyntaxNode[]): SyntaxNode {
  return { type, text, from: 0, to: 0, children };
}

export const num = (n: number | string): SyntaxNode => node("Number", String(n));

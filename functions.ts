/**
 * User-defined functions: registration metadata and the syntactic analyses
 * (referenced/assigned name sets) that call sites and variable demotion use.
 */

import { kids, type SyntaxNode } from "./syntax";
import type { Inst } from "./ir";

/** A user-defined function, registered before anything is lowered. */
export type FnInfo = {
  name: string;
  params: string[];
  body: SyntaxNode[];
  constexpr: boolean;
  node: SyntaxNode;
  callCount: number;
  // Filled in when the function is lowered for jal-style calls
  paramVregs: number[] | null;
  retVreg: number | null;
  lowered: Inst[] | null;
  // Names referenced/assigned by the body and its callees (syntactic), cached
  varRefs: Set<string> | null;
  varWrites: Set<string> | null;
};

export type FnTable = Map<string, FnInfo>;

/**
 * Names the function's body (and its callees') reads and assigns —
 * syntactic and over-approximate; call sites filter them against the
 * global scope to find the globals that need home registers.
 */
export function fnVarRefs(fn: FnInfo, fnTable: FnTable): { refs: Set<string>; writes: Set<string> } {
  if (fn.varRefs && fn.varWrites) return { refs: fn.varRefs, writes: fn.varWrites };
  const refs = new Set<string>();
  const writes = new Set<string>();
  const seen = new Set<string>([fn.name]);
  const walk = (node: SyntaxNode): void => {
    if (node.type === "VariableName") refs.add(node.text);
    if (node.type === "Assignment") {
      const target = kids(node)[0];
      if (target?.type === "VariableName") writes.add(target.text);
    }
    if (node.type === "FunctionCall") {
      const callee = fnTable.get(kids(node)[0]?.text ?? "");
      if (callee && !seen.has(callee.name)) {
        seen.add(callee.name);
        for (const statement of callee.body) walk(statement);
      }
    }
    for (const child of node.children) walk(child);
  };
  for (const statement of fn.body) walk(statement);
  fn.varRefs = refs;
  fn.varWrites = writes;
  return { refs, writes };
}

/**
 * Collect assignment target names inside a block, including nested
 * constructs and — since calls can write globals — the (transitive)
 * write sets of every function called in it.
 */
export function collectAssignedNames(block: SyntaxNode[], fnTable: FnTable, out: Set<string>): void {
  const walk = (node: SyntaxNode): void => {
    if (node.type === "Assignment") {
      // Only plain variable targets; device writes need no merge handling
      const target = kids(node)[0];
      if (target?.type === "VariableName") out.add(target.text);
    }
    if (node.type === "FunctionCall") {
      const callee = fnTable.get(kids(node)[0]?.text ?? "");
      if (callee) for (const name of fnVarRefs(callee, fnTable).writes) out.add(name);
    }
    if (node.type === "FunctionDef") return; // nested defs error elsewhere
    for (const child of node.children) walk(child);
  };
  for (const statement of block) walk(statement);
}

/** Number of `return` statements anywhere inside the block. */
export function countReturns(block: SyntaxNode[]): number {
  let count = 0;
  const walk = (node: SyntaxNode): void => {
    if (node.type === "Return") count++;
    // Nested function definitions are rejected elsewhere
    for (const child of node.children) walk(child);
  };
  for (const statement of block) walk(statement);
  return count;
}

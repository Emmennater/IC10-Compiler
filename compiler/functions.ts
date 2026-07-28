/**
 * User-defined functions: registration metadata and the syntactic analyses
 * (referenced/assigned name sets) that call sites and variable demotion use.
 */

import { childrenOf, type FormalSyntaxNode, type FunctionDef, type Statement } from "./formal-ast.ts";
import type { Inst } from "./ir.ts";

/** A user-defined function, registered before anything is lowered. */
export type FnInfo = {
  name: string;
  params: string[];
  body: Statement[];
  constexpr: boolean;
  node: FunctionDef;
  callCount: number;
  // Filled in when the function is lowered for jal-style calls
  paramVregs: number[] | null;
  retVreg: number | null;
  lowered: Inst[] | null;
  // Whether every call site inlines this body because it is shorter than the
  // call sequence would be. Decided once, from the lowered body's size, and
  // cached here so all call sites agree; null until the first call measures.
  alwaysInline: boolean | null;
  // Names referenced/assigned by the body and its callees (syntactic), cached
  varRefs: Set<string> | null;
  varWrites: Set<string> | null;
};

export type FnTable = Map<string, FnInfo>;

/** The name a plain `x = ...` / `x += ...` assigns, or null for a device write. */
function assignedName(node: FormalSyntaxNode): string | null {
  if (node.type !== "assignment" && node.type !== "compoundassignop") return null;
  return node.target.type === "identifier" ? node.target.name : null;
}

/**
 * Names the function's body (and its callees') reads and assigns -
 * syntactic and over-approximate; call sites filter them against the
 * global scope to find the globals that need home registers.
 */
export function fnVarRefs(fn: FnInfo, fnTable: FnTable): { refs: Set<string>; writes: Set<string> } {
  if (fn.varRefs && fn.varWrites) return { refs: fn.varRefs, writes: fn.varWrites };
  const refs = new Set<string>();
  const writes = new Set<string>();
  const seen = new Set<string>([fn.name]);
  const walk = (node: FormalSyntaxNode): void => {
    if (node.type === "identifier") refs.add(node.name);
    const written = assignedName(node);
    if (written !== null) writes.add(written);
    if (node.type === "functioncall") {
      const callee = fnTable.get(node.name.name);
      if (callee && !seen.has(callee.name)) {
        seen.add(callee.name);
        for (const statement of callee.body) walk(statement);
      }
    }
    for (const child of childrenOf(node)) walk(child);
  };
  for (const statement of fn.body) walk(statement);
  fn.varRefs = refs;
  fn.varWrites = writes;
  return { refs, writes };
}

/**
 * Collect assignment target names inside a block, including nested
 * constructs and - since calls can write globals - the (transitive)
 * write sets of every function called in it.
 */
export function collectAssignedNames(block: Statement[], fnTable: FnTable, out: Set<string>): void {
  const walk = (node: FormalSyntaxNode): void => {
    // Only plain variable targets; device writes need no merge handling
    const written = assignedName(node);
    if (written !== null) out.add(written);
    if (node.type === "functioncall") {
      const callee = fnTable.get(node.name.name);
      if (callee) for (const name of fnVarRefs(callee, fnTable).writes) out.add(name);
    }
    if (node.type === "functiondef") return; // nested defs error elsewhere
    for (const child of childrenOf(node)) walk(child);
  };
  for (const statement of block) walk(statement);
}

/** Number of `return` statements anywhere inside the block. */
export function countReturns(block: Statement[]): number {
  let count = 0;
  const walk = (node: FormalSyntaxNode): void => {
    if (node.type === "return") count++;
    // Nested function definitions are rejected elsewhere
    for (const child of childrenOf(node)) walk(child);
  };
  for (const statement of block) walk(statement);
  return count;
}

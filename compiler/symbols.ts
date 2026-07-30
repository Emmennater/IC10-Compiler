/**
 * Names and what they refer to: variables, devices, defines, and inlined
 * read-only parameters.
 *
 * A ScopeChain is an immutable value. Entering a block or a function body
 * does not modify anything - it constructs a new chain that shares the old
 * one - so there is no scope stack to unwind and no way for an error thrown
 * mid-lowering to leave name resolution corrupted. Capturing "the caller's
 * scopes" for an inlined parameter is just keeping the chain you already
 * have.
 *
 * The Scope maps themselves are mutable on purpose: a declaration adds an
 * entry to the innermost scope, and every chain sharing that scope sees it,
 * exactly as lexical scoping demands. What is immutable is the *chain* -
 * which scopes are visible, and where the function boundary sits.
 */

import type { DevicePin, Expression } from "./formal-ast.ts";
import type { Operand } from "./ir.ts";

/** One variable's compile-time state. */
export type VarState = {
  value: Operand | null; // null = unassigned so far
  maybe: boolean;        // assigned on some control-flow paths but not all
  home: number | null;   // while inside an if/loop that assigns this variable,
                         // every write also lands in this vreg
};

/** Anything a name can refer to. */
export type Sym =
  // `constant` marks a `const` binding: identical to `let` in every way
  // except that assigning to it is an error. Absent means `let`.
  | { kind: "var"; state: VarState; constant?: boolean }
  | { kind: "device"; pin: string }
  // `text` is what uses emit: the define's own name when a `define` line is
  // generated, or the substituted value for bare-identifier definitions
  | { kind: "define"; text: string; needsLine: boolean }
  // A read-only parameter of an inlined function: each use re-compiles the
  // argument expression in the caller's chain (textual inlining)
  | { kind: "alias"; argNode: Expression; callerChain: ScopeChain }
  // A block of stack memory, addresses `start` .. `start + size - 1`, on the
  // chip named by `device`: `db` for a list this program declared, another pin
  // for one imported from the module running on that chip
  | { kind: "list"; start: number; size: number; device: DevicePin }
  // One cell of stack memory - the single-element case of a list, read and
  // written by name instead of through an index
  | { kind: "stackvar"; addr: number; device: DevicePin };

export type Scope = Map<string, Sym>;

/**
 * An immutable view of the scopes visible at one point in the program.
 * Innermost scope last. `base` marks the innermost function boundary:
 * function bodies see globals (scope 0) and their own scopes, but never the
 * caller's variables.
 */
export class ScopeChain {
  private readonly scopes: readonly Scope[];
  private readonly base: number;

  private constructor(scopes: readonly Scope[], base: number) {
    this.scopes = scopes;
    this.base = base;
  }

  /** The chain a program starts with: one empty global scope. */
  static root(): ScopeChain {
    return new ScopeChain([new Map()], 0);
  }

  /**
   * The chain an imported function's body resolves names in: the exporting
   * module's constants stand where the program's globals would, and nothing
   * of the importing program is visible at all. That is the whole of what
   * makes a copied body mean the same thing here as it did there - the names
   * it could reach are exactly the ones it could reach before.
   */
  static forModule(constants: Scope): ScopeChain {
    return new ScopeChain([constants], 0);
  }

  /** Number of scopes visible (the root chain has depth 1). */
  get depth(): number {
    return this.scopes.length;
  }

  /** A new chain with one empty block scope on top. */
  child(): ScopeChain {
    return new ScopeChain([...this.scopes, new Map()], this.base);
  }

  /**
   * A new chain for a function body: the parameter scope goes on top and
   * becomes the visibility boundary, hiding every caller variable beneath
   * it (except globals).
   */
  functionFrame(paramScope: Scope): ScopeChain {
    return new ScopeChain([...this.scopes, paramScope], this.scopes.length);
  }

  /** Bind a name in the innermost scope. */
  declare(name: string, symbol: Sym): void {
    this.scopes[this.scopes.length - 1].set(name, symbol);
  }

  /** The global (top-level) binding of a name, if any. */
  globalGet(name: string): Sym | undefined {
    return this.scopes[0].get(name);
  }

  /**
   * Resolve a name, innermost scope first. Caller variables are not visible
   * inside a function body - except top-level globals, which functions may
   * read and write through the global's home register.
   */
  lookup(name: string): Sym | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const symbol = this.scopes[i].get(name);
      if (!symbol) continue;
      // If the symbol is at least one level above this scope, but not global, skip it
      if (i < this.base && i !== 0) return null;
      return symbol;
    }
    return null;
  }

  lookupVar(name: string): VarState | null {
    const symbol = this.lookup(name);
    return symbol?.kind === "var" ? symbol.state : null;
  }

  /**
   * Count how many variables in any scope on this chain - including ones
   * hidden by the function boundary - share this vreg as their value. Used
   * by demotion to decide whether a variable owns its vreg outright.
   */
  valueRefCount(id: number): number {
    let count = 0;
    for (const scope of this.scopes) {
      for (const symbol of scope.values()) {
        if (symbol.kind !== "var") continue;
        const state = symbol.state;
        if (state.value?.kind === "vreg" && state.value.id === id) count++;
      }
    }
    return count;
  }
}

/**
 * The two pieces of state whose lifetime is "the statement being lowered".
 *
 * They are kept together because they are one invariant, not two variables,
 * and because their reset points are *deliberately different* — an asymmetry
 * that is invisible when they sit as two sibling fields on a large class:
 *
 *  - `loads` is the placeholder read cache, so `a * a` loads `a` once. It is
 *    cleared at the end of every statement *and* mid-construct after a
 *    condition is lowered, because the loop body between the condition and
 *    the next iteration may write the placeholder.
 *  - `vregBase` marks where the current statement's virtual registers start.
 *    It moves only at statement boundaries. Rebasing it mid-construct would
 *    make `ownsVreg` stricter and cost real optimizations, so `clearLoads`
 *    deliberately leaves it alone.
 */
export class StatementScope {
  private loads = new Map<string, number>();
  private vregBase: number;

  /**
   * @param vregBase the first virtual register id belonging to the current
   * statement. A nested function body inherits the caller's base (its own
   * first statement will rebase it) — hence the parameter.
   */
  constructor(vregBase: number) {
    this.vregBase = vregBase;
  }

  /** The vreg already holding this placeholder in the current statement. */
  cachedLoad(name: string): number | undefined {
    return this.loads.get(name);
  }

  rememberLoad(name: string, vreg: number): void {
    this.loads.set(name, vreg);
  }

  /**
   * Whether a value was produced by the statement being lowered, and so may
   * be retargeted into a home register instead of copied. Values from
   * earlier statements may be shared and must not be rewritten.
   */
  ownsVreg(id: number): boolean {
    return id >= this.vregBase;
  }

  /** Forget cached placeholder reads, keeping the current vreg base. */
  clearLoads(): void {
    this.loads = new Map();
  }

  /** Start a new statement: drop the cache and rebase vreg ownership. */
  beginStatement(nextVregId: number): void {
    this.loads = new Map();
    this.vregBase = nextVregId;
  }

  /** A scope for a nested function body: fresh cache, inherited base. */
  forNestedBody(): StatementScope {
    return new StatementScope(this.vregBase);
  }
}

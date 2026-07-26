/**
 * Compiler for translating high-level code to IC10.
 *
 * Custom language reference: ./README.md
 * IC10 Reference: https://stationeers-wiki.com/IC10
 *
 * The pipeline runs in three phases, one module each:
 *
 *   1. Lowering (lowering.ts): the AST becomes a linear IR over infinite
 *      virtual registers. Constants fold, copies are free, conditions fuse
 *      into branches, and variables assigned inside forks are demoted to
 *      shared "home" registers so merges need no phis.
 *   2. Optimization (optimize.ts + liveness.ts): iterative backward
 *      liveness drives dead code elimination, alternating with structural
 *      cleanups (empty ifs/loops, unreachable code, redundant jumps) to a
 *      fixed point.
 *   3. Register allocation and emission (regalloc.ts + render.ts):
 *      linear-scan allocation maps virtual registers onto the configured
 *      register order; pressure is relieved first by sinking placeholder
 *      stores, then by spilling to fixed stack addresses.
 *
 *   r16 (sp) and r17 (ra) are reserved for stack and function support.
 */

import { checkSyntax, ErrorReporter, type SyntaxNode } from "./syntax";
import { IdAllocator } from "./ir";
import { RESERVED_REGISTER_BASE, VAR_REGISTER_ORDER } from "./tables";
import { Lowerer } from "./lowering";
import { optimize } from "./optimize";
import { allocateRegisters } from "./regalloc";
import { renderProgram, resolveLabels } from "./render";

export { CompileError } from "./syntax";
export type { SyntaxNode } from "./syntax";

export type Config = {
  /** Replace labels with absolute line numbers in the output. */
  removeLabels: boolean;
  /** Physical registers available to the allocator, in preference order. */
  registerOrder: number[];
};

export const DEFAULT_CONFIG: Config = {
  removeLabels: false,
  registerOrder: [...VAR_REGISTER_ORDER],
};

/**
 * Reject register orders the allocator cannot honour. Without this an empty
 * or malformed order surfaces much later as a misleading "out of stack
 * memory" error after 512 futile spill rounds, or emits `r99` into the
 * program. Throws a plain Error: this is a caller mistake, not a fault in
 * the compiled source, so it carries no source range.
 */
function validateConfig(registerOrder: readonly number[]): void {
  if (registerOrder.length === 0) {
    throw new Error("registerOrder must name at least one register");
  }
  for (const r of registerOrder) {
    if (!Number.isInteger(r) || r < 0 || r >= RESERVED_REGISTER_BASE) {
      throw new Error(
        `registerOrder entries must be integers in 0..${RESERVED_REGISTER_BASE - 1} ` +
        `(r${RESERVED_REGISTER_BASE} and above are reserved for sp/ra); got ${r}`);
    }
  }
  if (new Set(registerOrder).size !== registerOrder.length) {
    throw new Error("registerOrder must not repeat a register");
  }
}

/** Compile a parsed program to IC10 assembly text. */
export function compile(ast: SyntaxNode, config: Partial<Config> = {}): string {
  const removeLabels = config.removeLabels ?? DEFAULT_CONFIG.removeLabels;
  const registerOrder = config.registerOrder ?? DEFAULT_CONFIG.registerOrder;
  validateConfig(registerOrder);

  const errors = new ErrorReporter(ast.text);
  checkSyntax(ast, errors);

  const ids = new IdAllocator();
  const { program, ifRegions, loopRegions } = new Lowerer(ast, errors, ids).lower();
  const optimized = optimize(program, ifRegions, loopRegions);
  const { program: allocated, registerOf } =
    allocateRegisters(optimized, { registerOrder, ids, errors, rootNode: ast });

  const output = renderProgram(allocated, registerOf);
  return removeLabels ? resolveLabels(output) : output;
}

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

import { CompileError, checkSyntax, ErrorReporter, type SyntaxNode } from "./syntax.ts";
import { getFormalAST, getPartialFormalAST } from "./formal-ast.ts";
import { IdAllocator } from "./ir.ts";
import { RESERVED_REGISTER_BASE, VAR_REGISTER_ORDER } from "./tables.ts";
import { INLINE_THRESHOLD, Lowerer, type FileHandler, type LoweredProgram } from "./lowering.ts";
import { optimize } from "./optimize.ts";
import { allocateRegisters } from "./regalloc.ts";
import { renderProgram, resolveLabels } from "./render.ts";

export { CompileError } from "./syntax.ts";
export type { SyntaxNode } from "./syntax.ts";
export type { FileHandler } from "./lowering.ts";

export type Config = {
  /** Replace labels with absolute line numbers in the output. */
  removeLabels: boolean;
  /** Physical registers available to the allocator, in preference order. */
  registerOrder: number[];
  /**
   * A function whose lowered body is shorter than this is inlined at every
   * call site instead of being called (see `INLINE_THRESHOLD` in
   * lowering.ts). 0 disables the rule, leaving only the single-call-site
   * inlining, which is unconditional.
   */
  inlineThreshold: number;
};

export const DEFAULT_CONFIG: Config = {
  removeLabels: false,
  registerOrder: [...VAR_REGISTER_ORDER],
  inlineThreshold: INLINE_THRESHOLD,
};

/**
 * Reject register orders the allocator cannot honour. Without this an empty
 * or malformed order surfaces much later as a misleading "out of stack
 * memory" error after 512 futile spill rounds, or emits `r99` into the
 * program. Throws a plain Error: this is a caller mistake, not a fault in
 * the compiled source, so it carries no source range.
 */
function validateConfig(registerOrder: readonly number[], inlineThreshold: number): void {
  if (!Number.isInteger(inlineThreshold) || inlineThreshold < 0) {
    throw new Error(`inlineThreshold must be a non-negative integer; got ${inlineThreshold}`);
  }
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

/** The config a compile actually runs with, defaults filled in and checked. */
function resolveConfig(config: Partial<Config>): Config {
  const settings: Config = {
    removeLabels: config.removeLabels ?? DEFAULT_CONFIG.removeLabels,
    registerOrder: config.registerOrder ?? DEFAULT_CONFIG.registerOrder,
    inlineThreshold: config.inlineThreshold ?? DEFAULT_CONFIG.inlineThreshold,
  };
  validateConfig(settings.registerOrder, settings.inlineThreshold);
  return settings;
}

/** Phases 2 and 3: everything downstream of a fully lowered program. */
function backEnd(
  lowered: LoweredProgram,
  ast: SyntaxNode,
  errors: ErrorReporter,
  ids: IdAllocator,
  settings: Config,
): string {
  const { program, ifRegions, loopRegions } = lowered;
  const optimized = optimize(program, ifRegions, loopRegions);
  const { program: allocated, registerOf } = allocateRegisters(
    optimized, { registerOrder: settings.registerOrder, ids, errors, rootNode: ast });

  const output = renderProgram(allocated, registerOf);
  return settings.removeLabels ? resolveLabels(output) : output;
}

/**
 * Compile a parsed program to IC10 assembly text.
 * @param ast The programs AST
 * @param config Compiler configuration
 * @param fileHandler Callback for retrieving file contents, for `import`
 * */
export function compile(
  ast: SyntaxNode,
  config: Partial<Config> = {},
  fileHandler: FileHandler = () => undefined,
): string {
  const settings = resolveConfig(config);
  const errors = new ErrorReporter(ast.text);
  // Checked here rather than left to getFormalAST so the whole compile shares
  // one reporter; getFormalAST builds its own to stay usable on its own.
  checkSyntax(ast, errors);

  const ids = new IdAllocator();
  const lowered =
    new Lowerer(getFormalAST(ast), errors, ids, settings.inlineThreshold).lower(fileHandler);
  return backEnd(lowered, ast, errors, ids, settings);
}

/**
 * Everything wrong with a program, in source order, instead of only the first
 * thing `compile` trips over. An empty array means `compile` would succeed.
 *
 * How many errors come back depends on how early they are, because recovery
 * costs precision:
 *
 * - **Parse and shape errors** are collected per statement (`getPartialFormalAST`),
 *   so a file with five malformed lines reports five. Nothing is lowered when
 *   there are any: the tree is missing those statements, and lowering it would
 *   invent problems the source does not have.
 * - **Lowering errors** are collected per *top-level* statement. A statement
 *   that fails is abandoned where it stood, and the ones after it still lower
 *   against whatever it had already declared, so the errors past the first are
 *   plausible rather than guaranteed - which is the right trade for an editor
 *   underlining lines, and the reason nothing is emitted from that run.
 * - **Register allocation** reports one error, and only when lowering was
 *   clean. It sees the whole program at once, so there is no statement to
 *   recover to.
 */
export function diagnose(
  ast: SyntaxNode,
  config: Partial<Config> = {},
  fileHandler: FileHandler = () => undefined,
): CompileError[] {
  const settings = resolveConfig(config);
  const errors = new ErrorReporter(ast.text);
  const { block, errors: parseErrors } = getPartialFormalAST(ast, errors);
  if (parseErrors.length > 0) return parseErrors;

  const collected: CompileError[] = [];
  try {
    const ids = new IdAllocator();
    const lowered =
      new Lowerer(block, errors, ids, settings.inlineThreshold).lower(fileHandler, collected);
    // A recovered lowering skipped whatever failed, so the program it produced
    // is not this source's; only its diagnostics are worth anything.
    if (collected.length === 0) backEnd(lowered, ast, errors, ids, settings);
  } catch (thrown) {
    if (!(thrown instanceof CompileError)) throw thrown;
    collected.push(thrown);
  }
  return collected;
}

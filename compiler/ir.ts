/**
 * The linear intermediate representation (IR): operands over infinite
 * virtual registers, the instruction set, and the small pure helpers every
 * later phase (dead code elimination, allocation, rendering) shares.
 */

import type { SourceRange } from "./syntax.ts";

// ------------------------------ operands --------------------------------

/** A virtual register; the allocator later maps ids onto real r0..r15. */
export type VRegOperand = { kind: "vreg"; id: number };

/** A numeric literal, stored as its exact IC10 spelling. */
export type ConstOperand = { kind: "const"; text: string };

/**
 * Symbolic text emitted verbatim: device aliases, define names, HASH("..."),
 * game constants like DisplayMode.Seconds. Valid inline anywhere a number is.
 */
export type SymOperand = { kind: "sym"; text: string };

export type Operand = VRegOperand | ConstOperand | SymOperand;

export const vregOp = (id: number): VRegOperand => ({ kind: "vreg", id });
export const symOp = (text: string): SymOperand => ({ kind: "sym", text });
export const constTextOp = (text: string): ConstOperand => ({ kind: "const", text });
export const constBoolOp = (value: boolean): ConstOperand => ({ kind: "const", text: value ? "1" : "0" });

/** Make a constant operand, or null if the value has no plain IC10 literal. */
export function constOp(value: number): ConstOperand | null {
  if (!Number.isFinite(value)) return null;
  const text = String(value);
  if (text.includes("e") || text.includes("E")) return null;
  return { kind: "const", text };
}

/** Whether the operand is a constant with exactly this spelling. */
export function isConstText(operand: Operand, text: string): boolean {
  return operand.kind === "const" && operand.text === text;
}

/** Whether the operand is a constant equal to zero (any spelling). */
export function isZero(operand: Operand): boolean {
  return operand.kind === "const" && parseFloat(operand.text) === 0;
}

// ---------------------------- instructions ------------------------------

/**
 * Every instruction owns a unique, monotonically increasing id. Ids order
 * instructions across emission buffers (function bodies are emitted into
 * separate buffers and assembled later), and the region metadata below
 * refers to instructions by id ranges.
 */
export type Inst =
  | { id: number; op: "alu"; opcode: string; dest: number; args: Operand[]; node: SourceRange }
  | { id: number; op: "movev"; dest: number; src: Operand; node: SourceRange }
  | { id: number; op: "loadname"; dest: number; name: string; node: SourceRange }
  | { id: number; op: "storename"; name: string; src: Operand; node: SourceRange }
  // Stack memory access. `device` is the pin the memory sits behind: `db` is
  // this chip's own stack, and any other pin is a list or stack variable
  // imported from another module, which lives on that module's chip.
  | { id: number; op: "get"; dest: number; device: string; addr: Operand; node: SourceRange }
  | { id: number; op: "put"; device: string; addr: Operand; src: Operand; node: SourceRange }
  // Reserve space in the stack for lists
  | { id: number; op: "reserve"; name: string; size: number; node: SourceRange }
  // A raw IC10 instruction (yield, sleep, l, s, ls, lb, user calls, ...).
  // With a dest it is a pure value producer (dest is the first operand);
  // without one it is a side effect and always survives.
  | { id: number; op: "call"; opcode: string; dest: number | null; args: Operand[]; node: SourceRange }
  // alias/define lines survive only if their name is used by kept code
  | { id: number; op: "alias"; name: string; device: string; node: SourceRange }
  | { id: number; op: "definedef"; name: string; value: string; node: SourceRange }
  | { id: number; op: "label"; name: string; node: SourceRange }
  | { id: number; op: "jump"; target: string; node: SourceRange }
  | { id: number; op: "branch"; opcode: string; args: Operand[]; target: string; node: SourceRange }
  // Function call/return: jal jumps to the function's label and comes back;
  // ret emits `j ra`. Parameters and results travel through shared vregs.
  | { id: number; op: "jal"; target: string; node: SourceRange }
  | { id: number; op: "ret"; fn: string; node: SourceRange };

/** Omit that distributes over a union instead of collapsing it. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An instruction that has not been numbered yet. */
export type UnnumberedInst = DistributiveOmit<Inst, "id">;

/**
 * Issues the two id sequences the whole pipeline shares: virtual register
 * ids and instruction ids. Lowering creates most of them; the register
 * allocator continues both sequences when it rewrites spilled values.
 */
export class IdAllocator {
  private vregs = 0;
  private instIds = 0;

  newVreg(): number {
    return this.vregs++;
  }

  newInstId(): number {
    return this.instIds++;
  }

  /** The id the next newVreg() call will return (a watermark, not an id in use). */
  get nextVregId(): number {
    return this.vregs;
  }

  /** The id the next newInstId() call will return. */
  get nextInstId(): number {
    return this.instIds;
  }
}

// ------------------------------ accessors -------------------------------

/**
 * Compile-time proof that a switch covered every member of a union. Reaching
 * it at runtime means the union grew and a switch did not.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Internal error: unhandled ${context}: ${JSON.stringify(value)}`);
}

/**
 * The vreg an instruction defines, or null if it defines none.
 *
 * Every case is listed rather than falling back to `default`, so adding an
 * instruction kind that defines a register is a compile error here instead
 * of a value silently treated as defining nothing (which would propagate
 * into liveness, dead code elimination, and spilling).
 */
export function destOf(inst: Inst): number | null {
  switch (inst.op) {
    case "alu":
    case "movev":
    case "loadname":
    case "get":
    case "call":
      return inst.dest;
    case "reserve":
    case "storename":
    case "put":
    case "alias":
    case "definedef":
    case "label":
    case "jump":
    case "branch":
    case "jal":
    case "ret":
      return null;
  }
}

/** Retarget the defining instruction of a value onto another vreg. */
export function setDest(inst: Inst, dest: number): void {
  if (inst.op === "alu" || inst.op === "movev" || inst.op === "loadname" || inst.op === "get") {
    inst.dest = dest;
  } else if (inst.op === "call" && inst.dest !== null) {
    inst.dest = dest;
  }
}

/** All value operands an instruction reads. Exhaustive, as with destOf. */
export function operandsOf(inst: Inst): Operand[] {
  switch (inst.op) {
    case "alu":
    case "branch":
    case "call":
      return inst.args;
    case "movev":
    case "storename":
      return [inst.src];
    case "put":
      return [inst.addr, inst.src];
    case "get":
      return [inst.addr];
    case "reserve":
    case "loadname":
    case "alias":
    case "definedef":
    case "label":
    case "jump":
    case "jal":
    case "ret":
      return [];
  }
}

/** The vregs an instruction reads. */
export function usesOf(inst: Inst): number[] {
  return operandsOf(inst)
    .filter((o): o is VRegOperand => o.kind === "vreg")
    .map(o => o.id);
}

/** The symbolic names (aliases, defines, game constants) an instruction reads. */
export function symsOf(inst: Inst): string[] {
  return operandsOf(inst)
    .filter((o): o is SymOperand => o.kind === "sym")
    .map(o => o.text);
}

/** Whether the instruction must survive even if its value is unused. */
export function hasSideEffect(inst: Inst): boolean {
  // Calls without a destination write devices, sleep, yield, ...
  return inst.op === "storename" || inst.op === "put" ||
    (inst.op === "call" && inst.dest === null);
}

/** The consecutive instruction ids in [from, to). */
export function idRange(from: number, to: number): number[] {
  const ids: number[] = [];
  for (let i = from; i < to; i++) ids.push(i);
  return ids;
}

// --------------------------- region metadata ----------------------------

/** Metadata for one lowered if/elif/else, used by branch simplification. */
export type IfRegion = {
  arms: {
    condIds: number[];        // everything emitted for the condition
    branchIds: number[];      // just the conditional branches
    bodyFrom: number;         // inclusive inst-id range of the arm body
    bodyTo: number;
    jumpId: number | null;    // the `j endif` after the body
    labelName: string | null; // label that starts the NEXT arm
    labelId: number | null;
    // Whether the NEXT arm is an unconditional `else`. Recorded at lowering
    // time, where it is known exactly, so branch simplification never has to
    // infer control-flow structure from a generated label's spelling.
    nextIsElse: boolean;
  }[];
  endLabelName: string;
  endLabelId: number;
  simplified?: boolean;       // structural transforms are one-shot
};

/** Metadata for one lowered loop, used to prune empty loops. */
export type LoopRegion = {
  headLabelId: number;
  backJumpId: number;
  // Inclusive inst-id range of everything the back jump repeats: the body,
  // and also the condition test, whose re-evaluation is the only thing that
  // can end a loop with an empty body.
  bodyFrom: number;
  bodyTo: number;
};

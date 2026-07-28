/**
 * IC10 opcode tables and the arithmetic/bitwise/comparison semantics shared
 * by constant folding, the constexpr interpreter, and code generation.
 *
 * Keeping the semantics in one place guarantees that "fold at compile time"
 * and "execute on the chip" agree (IC10 reference: https://stationeers-wiki.com/IC10).
 *
 * Everything here is keyed by the operator's *meaning* - the opcode the
 * formal AST already resolved the source spelling to - not by the spelling
 * itself. An arithmetic opcode is its own IC10 instruction (`add`, `mod`),
 * so only the comparisons need tables at all.
 */

import type {
  ArithmeticOpcode, BinaryOpcode, BitwiseOpcode, ComparisonOpcode,
} from "./formal-ast.ts";

/**
 * First register reserved by the ABI: r16 is sp and r17 is ra, so only
 * r0..r15 are available for values.
 */
export const RESERVED_REGISTER_BASE = 16;

/** Preferred assignment order for variable registers. */
export const VAR_REGISTER_ORDER: readonly number[] =
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** Spilled values live at fixed stack addresses growing down from here. */
export const STACK_TOP = 511;

/** Comparison opcodes to the opcodes producing their result as data (0/1). */
export const SET_OPCODES: Readonly<Record<ComparisonOpcode, string>> = {
  eq: "seq", ne: "sne", gt: "sgt", lt: "slt", ge: "sge", le: "sle",
};

/** Branch opcodes that jump when the comparison is TRUE. */
export const BRANCH_TRUE: Readonly<Record<ComparisonOpcode, string>> = {
  eq: "beq", ne: "bne", gt: "bgt", lt: "blt", ge: "bge", le: "ble",
};

/** Branch opcodes that jump when the comparison is FALSE. */
export const BRANCH_FALSE: Readonly<Record<ComparisonOpcode, string>> = {
  eq: "bne", ne: "beq", gt: "ble", lt: "bge", ge: "blt", le: "bgt",
};

/** Mirror `0 OP x` into `x OP' 0` so the zero-compare forms apply. */
export const MIRROR: Readonly<Record<ComparisonOpcode, ComparisonOpcode>> = {
  eq: "eq", ne: "ne", gt: "lt", lt: "gt", ge: "le", le: "ge",
};

/** Flip a branch opcode to jump on the opposite outcome. */
export const INVERT_BRANCH: Readonly<Record<string, string>> = {
  beq: "bne", bne: "beq", bgt: "ble", ble: "bgt", blt: "bge", bge: "blt",
  beqz: "bnez", bnez: "beqz", bgtz: "blez", blez: "bgtz", bltz: "bgez", bgez: "bltz",
};

const COMPARATORS: Readonly<Record<ComparisonOpcode, (a: number, b: number) => boolean>> = {
  eq: (a, b) => a === b, ne: (a, b) => a !== b,
  gt: (a, b) => a > b, lt: (a, b) => a < b,
  ge: (a, b) => a >= b, le: (a, b) => a <= b,
};

/** Instructions that read a batch value and return it through their first operand. */
export const AGGREGATORS: ReadonlySet<string> = new Set(["Average", "Sum", "Minimum", "Maximum"]);

/** Friendlier spellings for IC10 opcodes. */
export const OPCODE_ALIASES: Readonly<Record<string, string>> = {
  loadSlot: "ls",
  setSlot: "ss",
};

/** Evaluate a comparison operator the way the IC10 chip does. */
export function compare(op: ComparisonOpcode, a: number, b: number): boolean {
  return COMPARATORS[op](a, b);
}

/** IC10's `mod` is a true modulo: the result takes the divisor's sign. */
export function ic10Mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Evaluate a binary arithmetic operator with IC10 semantics. */
export function applyArithmetic(op: ArithmeticOpcode, x: number, y: number): number {
  switch (op) {
    case "add": return x + y;
    case "sub": return x - y;
    case "mul": return x * y;
    case "div": return x / y;
    case "mod": return ic10Mod(x, y);
  }
}

/**
 * The 64-bit two's complement integer a register's double stands for, or
 * null when it stands for none: the chip truncates toward zero and wraps at
 * 64 bits, and nothing NaN or infinite survives that conversion.
 */
function toInt64(value: number): bigint | null {
  if (!Number.isFinite(value)) return null;
  return BigInt.asIntN(64, BigInt(Math.trunc(value)));
}

/**
 * Shifts count modulo 64, so `x << 64` is `x` rather than 0 - what the
 * chip's underlying 64-bit shift does with an out-of-range count.
 */
function shiftCount(value: bigint): bigint {
  return value & 63n;
}

/**
 * Evaluate a bitwise operator with IC10 semantics, or NaN when an operand
 * has no integer form. NaN is how the caller learns the operation did not
 * fold: `constOp` rejects it, so the instruction is emitted instead.
 *
 * Done in BigInt because the chip's words are 64 bits wide and JavaScript's
 * own bitwise operators are 32: `1 << 40` is 1099511627776 here and 256 in
 * plain JS. The result comes back as a double, which is what a register
 * holds - so a value past 2^53 rounds exactly as it would on the chip.
 */
export function applyBitwise(op: BitwiseOpcode, x: number, y: number): number {
  const a = toInt64(x);
  const b = toInt64(y);
  if (a === null || b === null) return NaN;
  switch (op) {
    case "and": return Number(a & b);
    case "or": return Number(a | b);
    case "xor": return Number(a ^ b);
    case "sll": return Number(BigInt.asIntN(64, a << shiftCount(b)));
    // Logical: the sign bit shifts in as data, so read the word as unsigned.
    case "srl": return Number(BigInt.asIntN(64, BigInt.asUintN(64, a) >> shiftCount(b)));
    // Arithmetic: BigInt's own >> already replicates the sign bit.
    case "sra": return Number(a >> shiftCount(b));
  }
}

/** Evaluate IC10's `not`: every bit of the 64-bit word flipped. */
export function applyBitwiseNot(x: number): number {
  const a = toInt64(x);
  if (a === null) return NaN;
  return Number(BigInt.asIntN(64, ~a));
}

/** Evaluate any binary operator - arithmetic or bitwise - as the chip does. */
export function applyBinary(op: BinaryOpcode, x: number, y: number): number {
  switch (op) {
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "mod":
      return applyArithmetic(op, x, y);
    default:
      return applyBitwise(op, x, y);
  }
}

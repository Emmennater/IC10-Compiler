/**
 * IC10 opcode tables and the arithmetic/comparison semantics shared by
 * constant folding, the constexpr interpreter, and code generation.
 *
 * Keeping the semantics in one place guarantees that "fold at compile time"
 * and "execute on the chip" agree (IC10 reference: https://stationeers-wiki.com/IC10).
 */

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

/** Binary arithmetic operators to their IC10 opcodes. */
export const ALU_OPCODES: Readonly<Record<string, string>> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "mod",
};

/** Comparison operators to the opcodes producing their result as data (0/1). */
export const SET_OPCODES: Readonly<Record<string, string>> = {
  "==": "seq", "!=": "sne", ">": "sgt", "<": "slt", ">=": "sge", "<=": "sle",
};

/** Operator spelling to the grammar's operator node type. */
export const OP_TYPES: Readonly<Record<string, string>> = {
  "+": "AddOp",
  "-": "AddOp",
  "*": "MulOp",
  "/": "MulOp",
  "%": "MulOp",
};

/** Branch opcodes that jump when the comparison is TRUE. */
export const BRANCH_TRUE: Readonly<Record<string, string>> = {
  "==": "beq", "!=": "bne", ">": "bgt", "<": "blt", ">=": "bge", "<=": "ble",
};

/** Branch opcodes that jump when the comparison is FALSE. */
export const BRANCH_FALSE: Readonly<Record<string, string>> = {
  "==": "bne", "!=": "beq", ">": "ble", "<": "bge", ">=": "blt", "<=": "bgt",
};

/** Mirror `0 OP x` into `x OP' 0` so the zero-compare forms apply. */
export const MIRROR: Readonly<Record<string, string>> = {
  "==": "==", "!=": "!=", ">": "<", "<": ">", ">=": "<=", "<=": ">=",
};

/** Flip a branch opcode to jump on the opposite outcome. */
export const INVERT_BRANCH: Readonly<Record<string, string>> = {
  beq: "bne", bne: "beq", bgt: "ble", ble: "bgt", blt: "bge", bge: "blt",
  beqz: "bnez", bnez: "beqz", bgtz: "blez", blez: "bgtz", bltz: "bgez", bgez: "bltz",
};

const COMPARATORS: Readonly<Record<string, (a: number, b: number) => boolean>> = {
  "==": (a, b) => a === b, "!=": (a, b) => a !== b,
  ">": (a, b) => a > b, "<": (a, b) => a < b,
  ">=": (a, b) => a >= b, "<=": (a, b) => a <= b,
};

/** Instructions that read a batch value and return it through their first operand. */
export const AGGREGATORS: ReadonlySet<string> = new Set(["Average", "Sum", "Minimum", "Maximum"]);

/** Friendlier spellings for IC10 opcodes. */
export const OPCODE_ALIASES: Readonly<Record<string, string>> = {
  loadSlot: "ls",
  setSlot: "ss",
};

/** Whether `op` is one of the binary arithmetic operators (+ - * / %). */
export function isArithmetic(op: string): boolean {
  return op in ALU_OPCODES;
}

/** Whether `op` is one of the comparison operators. */
export function isComparison(op: string): boolean {
  return op in COMPARATORS;
}

/** Evaluate a comparison operator the way the IC10 chip does. */
export function compare(op: string, a: number, b: number): boolean {
  return COMPARATORS[op](a, b);
}

/** IC10's `mod` is a true modulo: the result takes the divisor's sign. */
export function ic10Mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/**
 * Evaluate a binary arithmetic operator with IC10 semantics.
 * Callers must check isArithmetic(op) first.
 */
export function applyArithmetic(op: string, x: number, y: number): number {
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "/": return x / y;
    case "%": return ic10Mod(x, y);
    default: throw new Error(`Not an arithmetic operator: ${op}`);
  }
}

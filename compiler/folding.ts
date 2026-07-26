/**
 * Compile-time constant folding and register-pressure estimation.
 *
 * Both are pure functions over the formal AST. Neither emits code, mutates
 * anything, or knows what a virtual register is; the only thing they need
 * from the rest of the compiler is the answer to a question about a name,
 * which arrives as a one-method callback. That keeps this module readable
 * and testable on its own, with a hand-built node and a stub scope.
 */

import type { Expression } from "./formal-ast.ts";
import { constBoolOp, constOp, type ConstOperand } from "./ir.ts";
import { applyArithmetic, compare } from "./tables.ts";

/** What folding needs to know about a name: its constant value, if any. */
export type ConstantLookup = (name: string) => ConstOperand | null;

/** What pressure estimation needs: whether a name is declared at all. */
export type KnownNameLookup = (name: string) => boolean;

/** Truthiness of a folded constant; null when it did not fold. */
export function foldTruthy(operand: ConstOperand | null): boolean | null {
  if (!operand) return null;
  return parseFloat(operand.text) !== 0;
}

/**
 * Try to evaluate an expression to a compile-time constant without emitting
 * any code. `&&` and `||` fold when one side settles the outcome — the other
 * side is pure, so skipping it is safe.
 *
 * Returns null whenever the value is not known at compile time, including
 * for anything involving devices, placeholders, or calls.
 */
export function foldExpression(node: Expression, constantOf: ConstantLookup): ConstOperand | null {
  switch (node.type) {
    case "constant":
      return constOp(node.value);
    case "bool":
      return constBoolOp(node.value);
    case "identifier":
      return constantOf(node.name);
    case "unaryop": {
      const value = foldExpression(node.value, constantOf);
      if (!value) return null;
      if (node.opcode === "neg") return constOp(-parseFloat(value.text));
      if (node.opcode === "not") return constBoolOp(parseFloat(value.text) === 0);
      return value; // unary `+` is identity
    }
    case "binaryop": {
      const a = foldExpression(node.left, constantOf);
      const b = foldExpression(node.right, constantOf);
      if (!a || !b) return null;
      return constOp(applyArithmetic(node.opcode, parseFloat(a.text), parseFloat(b.text)));
    }
    case "comparisonop": {
      const a = foldExpression(node.left, constantOf);
      const b = foldExpression(node.right, constantOf);
      if (!a || !b) return null;
      return constBoolOp(compare(node.opcode, parseFloat(a.text), parseFloat(b.text)));
    }
    case "logicalop": {
      const a = foldTruthy(foldExpression(node.left, constantOf));
      const b = foldTruthy(foldExpression(node.right, constantOf));
      if (node.opcode === "and") {
        if (a === false || b === false) return constBoolOp(false);
        if (a === true && b === true) return constBoolOp(true);
        return null;
      }
      if (a === true || b === true) return constBoolOp(true);
      if (a === false && b === false) return constBoolOp(false);
      return null;
    }
    default:
      // Strings, devices, property reads and calls only exist at run time.
      return null;
  }
}

/**
 * How many registers evaluating this subtree keeps busy at once
 * (Sethi–Ullman-style labeling). Only used to pick evaluation order —
 * evaluate the register-hungrier side first — so an imprecise answer costs
 * code quality, never correctness. Real allocation happens later over the
 * whole program.
 */
export function pressure(node: Expression, isKnownName: KnownNameLookup): number {
  switch (node.type) {
    case "constant":
    case "bool":
    case "string":
    case "device":
      return 0;
    case "deviceprop":
      // Game constants are inline; device reads occupy a register
      if (node.device.type === "identifier" && !isKnownName(node.device.name)) return 0;
      return 1;
    case "devicechannelprop":
    case "devicenameprop":
    case "functioncall":
      return 1;
    case "identifier":
      // Placeholders must be loaded into a register; variables are free
      return isKnownName(node.name) ? 0 : 1;
    case "unaryop": {
      const inner = pressure(node.value, isKnownName);
      return node.opcode === "pos" ? inner : Math.max(inner, 1);
    }
    case "binaryop":
    case "comparisonop":
    case "logicalop": {
      const a = pressure(node.left, isKnownName);
      const b = pressure(node.right, isKnownName);
      return Math.max(a === b ? a + 1 : Math.max(a, b), 1);
    }
  }
}

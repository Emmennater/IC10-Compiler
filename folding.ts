/**
 * Compile-time constant folding and register-pressure estimation.
 *
 * Both are pure functions over the parse tree. Neither emits code, mutates
 * anything, or knows what a virtual register is; the only thing they need
 * from the rest of the compiler is the answer to a question about a name,
 * which arrives as a one-method callback. That keeps this module readable
 * and testable on its own, with a hand-built node and a stub scope.
 */

import { kids, EXPRESSION_TYPES, type SyntaxNode } from "./syntax.ts";
import { constBoolOp, constOp, type ConstOperand } from "./ir.ts";
import { applyArithmetic, compare, isArithmetic, isComparison } from "./tables.ts";

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
export function foldExpression(node: SyntaxNode, constantOf: ConstantLookup): ConstOperand | null {
  switch (node.type) {
    case "Number":
      return constOp(parseFloat(node.text));
    case "Bool":
      return constBoolOp(node.text === "true");
    case "VariableName":
      return constantOf(node.text);
    case "Parens": {
      const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
      return inner ? foldExpression(inner, constantOf) : null;
    }
    case "UnaryOp": {
      const [op, operand] = kids(node);
      const value = foldExpression(operand, constantOf);
      if (!value) return null;
      if (op.text === "-") return constOp(-parseFloat(value.text));
      if (op.text === "!") return constBoolOp(parseFloat(value.text) === 0);
      return value;
    }
    case "BinaryOp": {
      const [left, opNode, right] = kids(node);
      const op = opNode.text;
      const a = foldExpression(left, constantOf);
      const b = foldExpression(right, constantOf);
      if (op === "&&") {
        const truthyA = foldTruthy(a);
        const truthyB = foldTruthy(b);
        if (truthyA === false || truthyB === false) return constBoolOp(false);
        if (truthyA === true && truthyB === true) return constBoolOp(true);
        return null;
      }
      if (op === "||") {
        const truthyA = foldTruthy(a);
        const truthyB = foldTruthy(b);
        if (truthyA === true || truthyB === true) return constBoolOp(true);
        if (truthyA === false && truthyB === false) return constBoolOp(false);
        return null;
      }
      if (!a || !b) return null;
      const x = parseFloat(a.text);
      const y = parseFloat(b.text);
      if (isArithmetic(op)) return constOp(applyArithmetic(op, x, y));
      if (isComparison(op)) return constBoolOp(compare(op, x, y));
      return null;
    }
    default:
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
export function pressure(node: SyntaxNode, isKnownName: KnownNameLookup): number {
  switch (node.type) {
    case "Number":
    case "Bool":
    case "String":
    case "Device":
      return 0;
    case "DeviceProperty": {
      const base = kids(node)[0];
      // Game constants are inline; device reads occupy a register
      if (base.type !== "Device" && !isKnownName(base.text)) return 0;
      return 1;
    }
    case "DeviceChannelProperty":
    case "DeviceNameProperty":
    case "FunctionCall":
      return 1;
    case "VariableName":
      // Placeholders must be loaded into a register; variables are free
      return isKnownName(node.text) ? 0 : 1;
    case "Parens": {
      const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
      return inner ? pressure(inner, isKnownName) : 0;
    }
    case "UnaryOp": {
      const [op, operand] = kids(node);
      const inner = pressure(operand, isKnownName);
      return op.text === "+" ? inner : Math.max(inner, 1);
    }
    case "BinaryOp": {
      const [left, , right] = kids(node);
      const a = pressure(left, isKnownName);
      const b = pressure(right, isKnownName);
      return Math.max(a === b ? a + 1 : Math.max(a, b), 1);
    }
    default:
      return 0;
  }
}

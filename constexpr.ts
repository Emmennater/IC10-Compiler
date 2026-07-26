/**
 * Compile-time interpreter for @constexpr functions.
 *
 * When every argument of a call folds to a constant, the function body is
 * executed here instead of being lowered to instructions. Anything that
 * only exists at runtime (placeholders, devices, raw instructions) makes
 * the evaluation bail out, and the call is compiled normally instead.
 */

import { kids, blockOf, conditionOf, EXPRESSION_TYPES, type SyntaxNode } from "./syntax";
import { isArithmetic, isComparison, applyArithmetic, compare } from "./tables";
import type { FnInfo, FnTable } from "./functions";

/** The body did something that only exists at runtime, or ran too long. */
class BailSignal {}

/** Non-local control flow inside the interpreted program. */
class ReturnSignal {
  constructor(readonly value: number) {}
}
class BreakSignal {}
class ContinueSignal {}

/** A lexical environment: one map of variable values per open block. */
type Env = Map<string, number>[];

/** Evaluation budget, so accidental infinite loops fail fast instead of hanging. */
const MAX_STEPS = 200_000;

export class ConstexprEvaluator {
  private steps = 0;

  constructor(private readonly fnTable: FnTable) {}

  /**
   * Interpret a @constexpr function at compile time. Returns null when the
   * body does something that only exists at runtime (placeholders, devices,
   * raw instructions) or when the evaluation budget runs out.
   */
  evaluate(fn: FnInfo, args: number[]): number | null {
    this.steps = 0;
    try {
      const result = this.run(fn, args);
      return Number.isFinite(result) ? result : null;
    } catch (e) {
      // Every signal type is caught, not just BailSignal: a `break` or
      // `continue` outside any loop escapes execStatement, and letting it
      // out of here would surface as a bare non-Error object with no
      // message. Bailing hands the call to the normal lowering path, which
      // reports it properly ("break outside of a loop").
      if (e instanceof BailSignal || e instanceof BreakSignal ||
          e instanceof ContinueSignal || e instanceof ReturnSignal) {
        return null;
      }
      throw e;
    }
  }

  private tick(): void {
    if (++this.steps > MAX_STEPS) throw new BailSignal();
  }

  private run(callee: FnInfo, argValues: number[]): number {
    this.tick();
    const envs: Env = [new Map(callee.params.map((p, i) => [p, argValues[i]]))];
    try {
      for (const statement of callee.body) this.execStatement(statement, envs);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    throw new BailSignal(); // fell off the end without returning a value
  }

  private findEnv(envs: Env, name: string): Map<string, number> | null {
    for (let i = envs.length - 1; i >= 0; i--) {
      if (envs[i].has(name)) return envs[i];
    }
    return null;
  }

  private evalNode(node: SyntaxNode, envs: Env): number {
    this.tick();
    switch (node.type) {
      case "Number": return parseFloat(node.text);
      case "Bool": return node.text === "true" ? 1 : 0;
      case "VariableName": {
        const env = this.findEnv(envs, node.text);
        if (!env) throw new BailSignal();
        return env.get(node.text)!;
      }
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        if (!inner) throw new BailSignal();
        return this.evalNode(inner, envs);
      }
      case "UnaryOp": {
        const [op, operand] = kids(node);
        const value = this.evalNode(operand, envs);
        if (op.text === "-") return -value;
        if (op.text === "!") return value === 0 ? 1 : 0;
        return value;
      }
      case "BinaryOp": {
        const [left, opNode, right] = kids(node);
        const op = opNode.text;
        if (op === "&&") return this.evalNode(left, envs) !== 0 && this.evalNode(right, envs) !== 0 ? 1 : 0;
        if (op === "||") return this.evalNode(left, envs) !== 0 || this.evalNode(right, envs) !== 0 ? 1 : 0;
        const x = this.evalNode(left, envs);
        const y = this.evalNode(right, envs);
        if (isComparison(op)) return compare(op, x, y) ? 1 : 0;
        if (isArithmetic(op)) return applyArithmetic(op, x, y);
        throw new BailSignal();
      }
      case "FunctionCall": {
        const parts = kids(node);
        const callee = this.fnTable.get(parts[0].text);
        if (!callee) throw new BailSignal();
        const argNodes = parts.filter(c => EXPRESSION_TYPES.has(c.type));
        if (argNodes.length !== callee.params.length) throw new BailSignal();
        return this.run(callee, argNodes.map(a => this.evalNode(a, envs)));
      }
      default:
        throw new BailSignal();
    }
  }

  private execBlock(block: SyntaxNode[], envs: Env): void {
    envs.push(new Map());
    try {
      for (const statement of block) this.execStatement(statement, envs);
    } finally {
      envs.pop();
    }
  }

  private execStatement(statement: SyntaxNode, envs: Env): void {
    this.tick();
    const parts = kids(statement);
    switch (statement.type) {
      case "Declaration": {
        const nameNode = parts.find(c => c.type === "VariableName")!;
        const assignIdx = parts.findIndex(c => c.type === "Assign");
        const value = assignIdx >= 0 ? this.evalNode(parts[assignIdx + 1], envs) : NaN;
        envs[envs.length - 1].set(nameNode.text, value);
        return;
      }
      case "Assignment": {
        const target = parts[0];
        if (target.type !== "VariableName") throw new BailSignal();
        const env = this.findEnv(envs, target.text);
        if (!env) throw new BailSignal(); // placeholder write = side effect
        const opNode = parts.find(c => c.type === "Assign" || c.type === "CompoundAssignOp");
        if (!opNode) throw new BailSignal();
        const opIdx = parts.indexOf(opNode);
        const rhs = this.evalNode(parts[opIdx + 1], envs);
        const result = opNode.type === "CompoundAssignOp"
          ? applyArithmetic(opNode.text[0], env.get(target.text)!, rhs)
          : rhs;
        env.set(target.text, result);
        return;
      }
      case "Return": {
        const expr = parts.find(c => EXPRESSION_TYPES.has(c.type));
        if (!expr) throw new BailSignal();
        throw new ReturnSignal(this.evalNode(expr, envs));
      }
      case "IfExpr": {
        for (const part of parts) {
          if (part.type === "If" || part.type === "ElseIf") {
            const cond = conditionOf(part);
            if (cond && this.evalNode(cond, envs) !== 0) {
              this.execBlock(blockOf(part), envs);
              return;
            }
          } else if (part.type === "Else") {
            this.execBlock(blockOf(part), envs);
            return;
          }
        }
        return;
      }
      case "LoopExpr":
      case "WhileExpr":
      case "RepeatUntilExpr": {
        const cond = statement.type === "LoopExpr" ? null : conditionOf(statement);
        const body = blockOf(statement);
        for (;;) {
          this.tick();
          if (statement.type === "WhileExpr" && cond && this.evalNode(cond, envs) === 0) return;
          try {
            this.execBlock(body, envs);
          } catch (e) {
            if (e instanceof BreakSignal) return;
            if (!(e instanceof ContinueSignal)) throw e;
          }
          if (statement.type === "RepeatUntilExpr" && cond && this.evalNode(cond, envs) !== 0) return;
        }
      }
      case "break": throw new BreakSignal();
      case "continue": throw new ContinueSignal();
      case "Comment": return;
      default:
        throw new BailSignal(); // yield/sleep/devices/etc. only exist at runtime
    }
  }
}

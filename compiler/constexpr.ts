/**
 * Compile-time interpreter for @constexpr functions.
 *
 * When every argument of a call folds to a constant, the function body is
 * executed here instead of being lowered to instructions. Anything that
 * only exists at runtime (placeholders, devices, raw instructions) makes
 * the evaluation bail out, and the call is compiled normally instead.
 */

import type { Expression, Statement } from "./formal-ast.ts";
import { applyBinary, applyBitwiseNot, compare } from "./tables.ts";
import type { FnInfo, FnTable } from "./functions.ts";

/** The body did something that only exists at runtime, or ran too long. */
class BailSignal {}

/** Non-local control flow inside the interpreted program. */
class ReturnSignal {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}
class BreakSignal {}
class ContinueSignal {}

/** A lexical environment: one map of variable values per open block. */
type Env = Map<string, number>[];

/** Evaluation budget, so accidental infinite loops fail fast instead of hanging. */
const MAX_STEPS = 200_000;

export class ConstexprEvaluator {
  private steps = 0;
  private readonly fnTable: FnTable;

  constructor(fnTable: FnTable) {
    this.fnTable = fnTable;
  }

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

  private evalNode(node: Expression, envs: Env): number {
    this.tick();
    switch (node.type) {
      case "constant": return node.value;
      case "bool": return node.value ? 1 : 0;
      case "identifier": {
        const env = this.findEnv(envs, node.name);
        if (!env) throw new BailSignal();
        return env.get(node.name)!;
      }
      case "unaryop": {
        const value = this.evalNode(node.value, envs);
        if (node.opcode === "neg") return -value;
        if (node.opcode === "not") return value === 0 ? 1 : 0;
        if (node.opcode === "bitnot") return applyBitwiseNot(value);
        return value;
      }
      case "binaryop":
        return applyBinary(node.opcode, this.evalNode(node.left, envs), this.evalNode(node.right, envs));
      case "comparisonop":
        return compare(node.opcode, this.evalNode(node.left, envs), this.evalNode(node.right, envs)) ? 1 : 0;
      case "logicalop": {
        // JavaScript's own short circuit is the language's short circuit
        if (node.opcode === "and") {
          return this.evalNode(node.left, envs) !== 0 && this.evalNode(node.right, envs) !== 0 ? 1 : 0;
        }
        return this.evalNode(node.left, envs) !== 0 || this.evalNode(node.right, envs) !== 0 ? 1 : 0;
      }
      case "ternaryop":
        // Evaluating only the chosen arm, unlike the `select` the compiled
        // form emits: nothing here has an effect to miss, and the arm not
        // taken is free to be one the interpreter would bail on.
        return this.evalNode(node.condition, envs) !== 0
          ? this.evalNode(node.then, envs)
          : this.evalNode(node.else, envs);
      case "functioncall": {
        const callee = this.fnTable.get(node.name.name);
        if (!callee) throw new BailSignal();
        if (node.params.length !== callee.params.length) throw new BailSignal();
        return this.run(callee, node.params.map(a => this.evalNode(a, envs)));
      }
      default:
        throw new BailSignal();
    }
  }

  private execBlock(block: Statement[], envs: Env): void {
    envs.push(new Map());
    try {
      for (const statement of block) this.execStatement(statement, envs);
    } finally {
      envs.pop();
    }
  }

  private execStatement(statement: Statement, envs: Env): void {
    this.tick();
    switch (statement.type) {
      case "declaration": {
        const value = statement.value ? this.evalNode(statement.value, envs) : NaN;
        envs[envs.length - 1].set(statement.target.name, value);
        return;
      }
      case "assignment":
      case "compoundassignop": {
        const target = statement.target;
        if (target.type !== "identifier") throw new BailSignal();
        const env = this.findEnv(envs, target.name);
        if (!env) throw new BailSignal(); // placeholder write = side effect
        const result = statement.type === "compoundassignop"
          ? applyBinary(statement.opcode, env.get(target.name)!, this.evalNode(statement.right, envs))
          : this.evalNode(statement.value, envs);
        env.set(target.name, result);
        return;
      }
      case "return":
        throw new ReturnSignal(this.evalNode(statement.value, envs));
      case "if": {
        for (const arm of statement.ifs) {
          if (this.evalNode(arm.condition, envs) !== 0) {
            this.execBlock(arm.then.statements, envs);
            return;
          }
        }
        if (statement.else) this.execBlock(statement.else.statements, envs);
        return;
      }
      case "loop":
      case "while":
      case "repeat": {
        const body = statement.body.statements;
        for (;;) {
          this.tick();
          if (statement.type === "while" && this.evalNode(statement.condition, envs) === 0) return;
          try {
            this.execBlock(body, envs);
          } catch (e) {
            if (e instanceof BreakSignal) return;
            if (!(e instanceof ContinueSignal)) throw e;
          }
          if (statement.type === "repeat" && this.evalNode(statement.until, envs) !== 0) return;
        }
      }
      case "break": throw new BreakSignal();
      case "continue": throw new ContinueSignal();
      default:
        throw new BailSignal(); // yield/sleep/devices/etc. only exist at runtime
    }
  }
}

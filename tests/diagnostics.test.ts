/**
 * The error-recovery layer: `diagnose` reporting more than one problem, and
 * the editor analyses staying useful while a program has them.
 *
 * `compile` is deliberately untouched by all of this -- it still throws the
 * first error, which every other suite pins -- so the cases here assert the
 * two things recovery adds: how many errors come back, and that scope
 * resolution survives them. Messages are asserted only where a case is about
 * one; the wording of a specific diagnostic belongs to tests/test.mjs.
 */

import { describe, expect, test } from "vitest";
import { getAST } from "../compiler/ast.ts";
import { compile, diagnose } from "../compiler/index.ts";
import { CompileError } from "../compiler/syntax.ts";
import { getFormalAST, getPartialFormalAST } from "../compiler/formal-ast.ts";
import { ErrorReporter } from "../compiler/syntax.ts";
import { analyzeScopes } from "../compiler/scope.ts";
import { getCompletions } from "../compiler/completions.ts";

const ORDER = [0, 1, 2];

function errorsIn(source: string): string[] {
  return diagnose(getAST(source), { registerOrder: ORDER }).map(e => e.message);
}

function namesAt(source: string, offset: number): string[] {
  return analyzeScopes(getAST(source)).symbolsAt(offset).map(s => s.name);
}

describe("diagnose reports every error", () => {
  test("a clean program has none, and compiles", () => {
    const source = "let x = 1\nc = x + 1";
    expect(errorsIn(source)).toEqual([]);
    expect(compile(getAST(source), { registerOrder: ORDER })).toBe("move c 2");
  });

  test("three malformed lines are three errors", () => {
    const errors = errorsIn("let = 1\nlet y = 2\nlet = 3\nc = y\nlet = 4");
    expect(errors).toEqual([
      "Line 0: Syntax error",
      "Line 2: Syntax error",
      "Line 4: Syntax error",
    ]);
  });

  test("errors come back in source order", () => {
    const errors = diagnose(getAST("c = 1\nlet = 2\nlet = 3"));
    expect(errors.map(e => e.from)).toEqual([...errors.map(e => e.from)].sort((a, b) => a - b));
  });

  test("a broken line inside a function body does not hide the one after it", () => {
    expect(errorsIn("fn f(a)\n  let = 1\n  let = 2\nend\nc = f(1)")).toEqual([
      "Line 1: Syntax error",
      "Line 2: Syntax error",
    ]);
  });

  test("lowering errors are collected per top-level statement", () => {
    // Neither line parses wrong; both are rejected while being lowered.
    expect(errorsIn("let x = 1\nlet x = 2\nlet y = 1\nlet y = 2")).toEqual([
      "Line 1: x was already defined",
      "Line 3: y was already defined",
    ]);
  });

  test("a lowering error is only reported once lowering is reached", () => {
    // The syntax error stops the pass before lowering, so the redeclaration
    // below it is not reported alongside a tree that is missing statements.
    expect(errorsIn("let = 1\nlet x = 2\nlet x = 3")).toEqual(["Line 0: Syntax error"]);
  });

  test("the first error agrees with what compile throws", () => {
    for (const source of ["let = 1\nc = 2", "let x = 1\nlet x = 2", "let x\nc = x"]) {
      const thrown = (() => {
        try {
          compile(getAST(source), { registerOrder: ORDER });
          return null;
        } catch (e) {
          return e as CompileError;
        }
      })();
      expect(thrown).toBeInstanceOf(CompileError);
      expect(errorsIn(source)[0]).toBe(thrown!.message);
    }
  });

  test("a config mistake is still a plain throw, not a diagnostic", () => {
    expect(() => diagnose(getAST("c = 1"), { registerOrder: [] })).toThrow(/at least one register/);
  });
});

describe("partial conversion", () => {
  test("drops only the statement the conversion cannot make sense of", () => {
    // `let arr[]` parses but is not a shape the formal tree has: an array needs
    // a size or an initializer to take one from.
    const source = "let x = 1\nlet arr[]\nlet y = 2";
    const { block, errors } = getPartialFormalAST(getAST(source), new ErrorReporter(source));
    expect(errors.map(e => e.message)).toEqual([
      "Array size must be given explicitly or inferred from an initializer list",
    ]);
    expect(block.statements.map(s => s.type)).toEqual(["declaration", "declaration"]);
  });

  test("recovers inside a nested block, not around it", () => {
    const source = "fn f(a)\n  let arr[]\n  return a\nend";
    const { block, errors } = getPartialFormalAST(getAST(source), new ErrorReporter(source));
    expect(errors).toHaveLength(1);
    const fn = block.statements[0];
    // The function survived its broken line; only that line is gone.
    expect(fn.type).toBe("functiondef");
    expect(fn.type === "functiondef" && fn.body.statements.map(s => s.type)).toEqual(["return"]);
  });

  test("a statement the parser patched up is kept, and still reported", () => {
    // Lezer recovers `let = 2` into a Declaration with an empty name, so the
    // tree keeps a statement the source does not really have. That is the
    // right trade for scope analysis -- the surrounding statements convert --
    // and the syntax error is reported either way.
    const source = "let x = 1\nlet = 2";
    const { block, errors } = getPartialFormalAST(getAST(source), new ErrorReporter(source));
    expect(errors.map(e => e.message)).toEqual(["Line 1: Syntax error"]);
    expect(block.statements).toHaveLength(2);
  });

  test("one line marked twice by the parser is one error", () => {
    // `let = 2` inside a body yields two ⚠ nodes; both say "Syntax error".
    const source = "fn f(a)\n  let = 2\nend";
    const { errors } = getPartialFormalAST(getAST(source), new ErrorReporter(source));
    expect(errors.map(e => e.message)).toEqual(["Line 1: Syntax error"]);
  });

  test("getFormalAST still throws at the first problem", () => {
    expect(() => getFormalAST(getAST("let x = 1\nlet = 2"))).toThrow(CompileError);
    expect(() => getFormalAST(getAST("let x = 1\nlet arr[]"))).toThrow(CompileError);
  });
});

describe("editor analyses survive an error", () => {
  test("names declared elsewhere still resolve", () => {
    // The half-typed line is what a completion request usually sits on.
    const source = "let speed = 1\nconst LIMIT = 2\nlet arr[]\nlet flow = 3";
    expect(namesAt(source, source.length)).toEqual(["speed", "LIMIT", "flow"]);
  });

  test("completions offer those names plus the keywords", () => {
    const source = "let pressure = 1\nlet = ";
    const labels = getCompletions(getAST(source), source.length).map(c => c.label);
    expect(labels).toContain("pressure");
    expect(labels).toContain("while");
  });

  test("a function's parameters are still in scope inside a broken body", () => {
    const source = "fn f(gain)\n  let = 1\n  return gain\nend";
    const offset = source.indexOf("return");
    expect(namesAt(source, offset)).toContain("gain");
  });

  test("readonly hints survive an error on another line", () => {
    const source = "const LIMIT = 2\nlet = 1\nc = LIMIT";
    const analysis = analyzeScopes(getAST(source));
    expect(analysis.errors).toHaveLength(1);
    expect(analysis.hintAt(source.indexOf("LIMIT", 10))).toBe("readonly");
  });

  test("errors are reported on the analysis, so undeclared can be distrusted", () => {
    expect(analyzeScopes(getAST("let x = 1\nc = x")).errors).toEqual([]);
    expect(analyzeScopes(getAST("let = 1")).errors).toHaveLength(1);
  });
});

/**
 * Differential suite: each source program in cases.ts is parsed with the
 * frozen pre-Value grammar for the pristine original and the bug-patched
 * original, and with the current grammar for the refactor, then all three
 * outputs are asserted against each other. See cases.ts for why two parsers
 * are needed and the invariants checked.
 */

import { describe, it, expect } from "vitest";
import * as original from "./original.ts";
import * as patched from "./original-patched.ts";
import { compile as refactored } from "../compiler/index.ts";
import { getOriginalAST } from "./ast-original.ts";
import { getAST } from "../compiler/ast.ts";
import { CASES } from "./cases.ts";
import { VAR_REGISTER_ORDER } from "../compiler/tables.ts";
import type { SyntaxNode } from "../compiler/syntax.ts";

type FullConfig = { removeLabels: boolean; registerOrder: number[] };

function runCompiler(
  compileFn: (ast: SyntaxNode, config: FullConfig) => string,
  ast: SyntaxNode,
  config: FullConfig,
): string {
  try {
    return compileFn(ast, config);
  } catch (e) {
    return "ERROR: " + (e as Error).message;
  }
}

const joinLines = (source: string | string[]): string =>
  Array.isArray(source) ? source.join("\n") : source;

describe("differential suite", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      // original.compile/patched.compile want every field; merge with the
      // same defaults each of the three compilers falls back to internally.
      const config: FullConfig = {
        removeLabels: testCase.config?.removeLabels ?? false,
        registerOrder: testCase.config?.registerOrder ?? [...VAR_REGISTER_ORDER],
      };

      const source = joinLines(testCase.source);
      const originalAst = getOriginalAST(source);
      const refactoredAst = getAST(source);

      const o = runCompiler(original.compile, originalAst, config);
      const p = runCompiler(patched.compile, originalAst, config);
      const r = runCompiler(refactored, refactoredAst, config);

      expect(r).toBe(p);

      if (testCase.expectOriginalDiff) {
        expect(r).not.toBe(o);
      } else {
        expect(r).toBe(o);
      }

      for (const substring of testCase.expect ?? []) {
        expect(r).toContain(substring);
      }
    });
  }
});

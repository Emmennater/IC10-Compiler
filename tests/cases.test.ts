/**
 * Differential suite: each hand-built AST in cases.ts is compiled by the
 * pristine original, the bug-patched original, and the refactor, then
 * asserted against each other. See cases.ts for the invariants checked.
 */

import { describe, it, expect } from "vitest";
import * as original from "./original.ts";
import * as patched from "./original-patched.ts";
import { compile as refactored } from "../compiler/index.ts";
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

describe("differential suite", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      // original.compile/patched.compile want every field; merge with the
      // same defaults each of the three compilers falls back to internally.
      const config: FullConfig = {
        removeLabels: testCase.config?.removeLabels ?? false,
        registerOrder: testCase.config?.registerOrder ?? [...VAR_REGISTER_ORDER],
      };

      const o = runCompiler(original.compile, testCase.ast, config);
      const p = runCompiler(patched.compile, testCase.ast, config);
      const r = runCompiler(refactored, testCase.ast, config);

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

/**
 * Differential suite: each source program in cases.ts is parsed with the
 * frozen pre-Value grammar for the pristine original and with the current
 * grammar for the refactor, then the two outputs are asserted against each
 * other. Cases that diverge from the original by design pin their full
 * output with `expected` instead. See cases.ts for why two parsers are
 * needed and the invariants checked.
 */

import { describe, it, expect } from "vitest";
import * as original from "./original.ts";
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
      // original.compile wants every field; merge with the same defaults
      // both compilers fall back to internally.
      const config: FullConfig = {
        removeLabels: testCase.config?.removeLabels ?? false,
        registerOrder: testCase.config?.registerOrder ?? [...VAR_REGISTER_ORDER],
      };

      const source = joinLines(testCase.source);
      const originalAst = getOriginalAST(source);
      const refactoredAst = getAST(source);

      const o = runCompiler(original.compile, originalAst, config);
      // The inline threshold is refactor-only; the original never inlines a
      // function with more than one call site, which is what 0 means here.
      const r = runCompiler(
        (ast, c) => refactored(ast, { ...c, inlineThreshold: testCase.config?.inlineThreshold }),
        refactoredAst, config);

      if (testCase.expectOriginalDiff) {
        expect(
          r,
          "case is flagged expectOriginalDiff but the refactor matched the pristine original",
        ).not.toBe(o);
        // The oracle disagrees here by design, so it cannot check the rest of
        // the output. A golden is mandatory or the case degrades to the
        // substring list the moment someone flags it.
        expect(
          testCase.expected,
          "a case flagged expectOriginalDiff must pin its full output with `expected`",
        ).toBeDefined();
      } else {
        // Diff reads `-` pristine original, `+` refactor.
        expect(r, "refactor output differs from the pristine original").toBe(o);
      }

      if (testCase.expected !== undefined) {
        expect(r, "output differs from the case's pinned golden").toBe(joinLines(testCase.expected));
      }

      for (const substring of testCase.expect ?? []) {
        expect(r, `output is missing an expected substring, in full:\n${r}`).toContain(substring);
      }
    });
  }
});

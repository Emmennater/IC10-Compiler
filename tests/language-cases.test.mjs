// Wraps test.mjs's source-string regression cases (real lezer parser, full
// pipeline) as vitest tests. `node test.mjs` still runs the same cases
// standalone; this file only adds vitest reporting on top.
//
// The comparison is string against string rather than `caseMatches(...) ===
// true` so that a failure reports the diff vitest builds from the two
// operands instead of "expected false to be true".
import { describe, it, expect } from "vitest";
import { cases, runCase, expectedText, actualText } from "./test.mjs";

describe("language regression cases (parser + compiler)", () => {
  for (const [name, spec] of Object.entries(cases)) {
    it(name, () => {
      expect(actualText(runCase(spec))).toBe(expectedText(spec));
    });
  }
});

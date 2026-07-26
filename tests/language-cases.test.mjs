// Wraps test.mjs's source-string regression cases (real lezer parser, full
// pipeline) as vitest tests. `node test.mjs` still runs the same cases
// standalone; this file only adds vitest reporting on top.
import { describe, it, expect } from "vitest";
import { cases, runCase, caseMatches } from "./test.mjs";

describe("language regression cases (parser + compiler)", () => {
  for (const [name, spec] of Object.entries(cases)) {
    it(name, () => {
      const actual = runCase(spec);
      expect(caseMatches(spec, actual)).toBe(true);
    });
  }
});

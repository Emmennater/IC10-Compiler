import { describe, expect, it } from "vitest";
import { runUnitTests } from "./units.ts";

describe("unit tests (leaf libraries)", () => {
  for (const result of runUnitTests()) {
    it(result.name, () => {
      if (result.pass) return;
      // `pass` stays the verdict - this only picks the most legible way to
      // report it. A value comparison is re-asserted so vitest diffs the two
      // operands; if toEqual is happier than the JSON comparison that set
      // `pass` (key order, say), the detail line below still fails the test.
      if (result.comparison) {
        expect(result.comparison.actual).toEqual(result.comparison.expected);
      }
      expect.fail(result.detail ?? "assertion failed");
    });
  }
});

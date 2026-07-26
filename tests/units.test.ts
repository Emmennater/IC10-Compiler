import { describe, it, expect } from "vitest";
import { runUnitTests } from "./units.ts";

describe("unit tests (leaf libraries)", () => {
  for (const result of runUnitTests()) {
    it(result.name, () => {
      expect(result.pass, result.detail).toBe(true);
    });
  }
});

// Fifth suite: the documentation's own examples.
//
// Every ```icc fence in docs.markdoc.md tagged `compile` or `error` claims
// something about the compiler, and the docs page checks that claim while
// rendering - but only when a browser loads it, which is exactly when a stale
// example is most expensive to discover. This runs the same check, through
// the same `runDocExample`, with no DOM involved.
//
// It is a *consistency* suite rather than a behavioral one: it pins no output
// of its own, because the fences do not either - a compiled fence renders
// whatever the compiler emits. What it catches is a language or compiler
// change that makes a documented program stop compiling, or makes a
// documented error message stop being an error. Pinning the IC10 text here
// too would only re-litigate what the other four suites already own, and
// would make every optimization a docs failure.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { docExamples, runDocExample, DOCS_FILE } from "../docs-examples.js";

const source = readFileSync(fileURLToPath(new URL(`../${DOCS_FILE}`, import.meta.url)), "utf8");
const examples = docExamples(source);

describe("documentation examples", () => {
  // Without this the suite passes gloriously on an extractor that matches
  // nothing - a docs file renamed, a fence syntax changed, a walk that stops
  // descending. The number is a floor, not a count, so adding examples never
  // fails the suite; losing most of them does.
  it("finds the examples at all", () => {
    expect(examples.length).toBeGreaterThan(30);
  });

  // A fence claiming both would be checked as an error fence and silently
  // never compiled, which reads in the source like the opposite.
  it("has no fence claiming both compile and error", () => {
    const both = examples.filter(e => e.compile && e.error).map(e => e.where);
    expect(both).toEqual([]);
  });

  for (const example of examples) {
    const claim = example.error ? "is rejected" : "compiles";
    it(`${example.where} ${claim}`, () => {
      // runDocExample throws with the location and the source when the
      // compiler disagrees with the fence; that message is the failure.
      const result = runDocExample(example);
      if (example.error) {
        expect(result.message).toMatch(/^Line \d+: /);
      } else {
        expect(typeof result.ic10).toBe("string");
      }
    });
  }
});

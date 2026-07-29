// The documentation's code examples, as data and as assertions.
//
// Every ```icc fence in docs.markdoc.md tagged `compile` or `error` is a
// claim about the compiler: that this source produces that IC10, or that it
// is rejected with that message. `runDocExample` is what checks the claim,
// and it is deliberately the *only* place that does — docs.js calls it while
// rendering the page (so a broken example breaks the page loudly instead of
// leaving a stale claim standing on it) and tests/docs.test.mjs calls it over
// the same fences without a browser. Two callers, one assertion: the suite
// cannot pass while the page throws.
//
// `docExamples` exists for the second caller only. The page never needs it:
// Markdoc's own transform walks the fences for it.

import Markdoc from "@markdoc/markdoc";
import { compile, CompileError } from "./compiler/index.ts";
import { getAST } from "./compiler/ast.ts";

/** The file the examples live in, for locations in failure messages. */
export const DOCS_FILE = "docs.markdoc.md";

/**
 * The fence attributes that turn a code block into a claim. Spelled once so
 * the schema in docs.js, the extractor below, and this module's reader agree
 * on what an example even is — the failure mode being an extractor that
 * quietly matches nothing and a suite that passes vacuously.
 */
export const EXAMPLE_ATTRIBUTES = ["compile", "error", "removeLabels"];

/** `docs.markdoc.md:42` for a Markdoc node's `lines`, or "" if it has none. */
export function locationOf(lines) {
  return lines?.length ? `${DOCS_FILE}:${lines[0] + 1}` : "";
}

/**
 * Compile one example and hold it to what its fence claims.
 *
 * Returns `{ ic10 }` for a `compile` fence and `{ message }` for an `error`
 * one. Throws when the compiler disagrees with the fence — a `compile`
 * example that fails, or an `error` example that compiles cleanly. A
 * non-CompileError is a fault in the compiler rather than in the example, so
 * it propagates untouched rather than being reported as a bad example.
 */
export function runDocExample({ code, compile: wantCompile, error: wantError, removeLabels = false, where = "" }) {
  const at = where ? ` (${where})` : "";

  let ic10 = null;
  let message = null;
  try {
    ic10 = compile(getAST(code), { removeLabels });
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    message = e.message;
  }

  if (wantError) {
    if (message === null) {
      throw new Error(`Doc example expected a compile error${at} but compiled cleanly:\n${code}`);
    }
    return { message };
  }

  if (!wantCompile) throw new Error(`Doc example${at} claims nothing; nothing to check`);

  if (message !== null) {
    throw new Error(`Doc example failed to compile${at}: ${message}\n${code}`);
  }
  return { ic10 };
}

/**
 * Every fence in `source` that makes a claim, in document order, shaped as
 * `runDocExample` takes them. Fences with no `compile`/`error` annotation are
 * plain listings that assert nothing and are skipped.
 */
export function docExamples(source) {
  const examples = [];
  for (const node of Markdoc.parse(source).walk()) {
    if (node.type !== "fence") continue;
    const { compile: wantCompile, error: wantError, removeLabels, content, language } = node.attributes;
    if (!wantCompile && !wantError) continue;
    examples.push({
      code: content,
      language,
      compile: Boolean(wantCompile),
      error: Boolean(wantError),
      removeLabels: Boolean(removeLabels),
      where: locationOf(node.lines),
    });
  }
  return examples;
}

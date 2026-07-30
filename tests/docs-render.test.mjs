// Sixth suite: the docs page's markup.
//
// docs.markdoc.md is rendered to HTML once, by Node, and injected into
// docs.html by the prerender plugin in vite.config.js - so the page's
// structure is now something a test can hold, where before it existed only
// after a browser ran docs.js.
//
// This is not a second docs suite. tests/docs.test.mjs owns the *claims* the
// fences make (that each example still compiles, or still fails); this owns the
// markup those fences and headings are rendered into, and pins nothing about
// the compiler's output. The two invariants it exists for both broke while the
// prerender was being written:
//
//   - heading ids. `Markdoc.transform` resolves the tree first and
//     `Node.resolve` returns *copies*, so an id computed against the parsed
//     nodes lands nowhere. That failed silently: the TOC linked to 43 anchors
//     that no heading carried, and every link did nothing.
//   - the ids and the TOC agreeing. They are generated in one pass for that
//     reason, and a second de-dup counter appearing anywhere would be the way
//     it regresses.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { renderDocsHtml } from "../docs-render.js";
import { DOCS_FILE } from "../docs-examples.js";

const source = readFileSync(fileURLToPath(new URL(`../${DOCS_FILE}`, import.meta.url)), "utf8");
const { content, toc } = renderDocsHtml(source);

const headingIds = [...content.matchAll(/<h[23] id="([^"]+)"/g)].map(m => m[1]);
const tocHrefs = [...toc.matchAll(/href="#([^"]+)"/g)].map(m => m[1]);

// Code in a rendered block is split into one `<span class="tok-…">` per token
// (that is what highlight.js is for), so an assertion about what a program
// compiled *to* has to read the text back out rather than search the markup
// for it.
const text = html => html.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("docs markup", () => {
  // A floor, not a count: the failure this guards is a renderer that emits
  // nothing and a suite that passes on it.
  it("renders the document", () => {
    expect(content.length).toBeGreaterThan(10000);
    expect(headingIds.length).toBeGreaterThan(20);
  });

  it("gives every h2 and h3 an id", () => {
    expect(content).not.toMatch(/<h[23]>/);
  });

  // The whole point of the ids: an anchor that resolves with no JS at all.
  it("points every TOC link at a heading that exists", () => {
    expect(tocHrefs).toEqual(headingIds);
    expect(new Set(headingIds).size).toBe(headingIds.length);
  });

  it("labels TOC entries with their heading level", () => {
    expect(toc).toMatch(/<li class="toc-level-2">/);
    expect(toc).toMatch(/<li class="toc-level-3">/);
  });

  // Two headings with the same text are what the de-dup counter is for, and
  // the real document happens not to contain any - so the case is made here
  // rather than left to the day someone adds one.
  it("distinguishes repeated heading text", () => {
    const repeated = renderDocsHtml("## Ports\n\ntext\n\n## Ports\n\ntext\n");
    expect([...repeated.content.matchAll(/<h2 id="([^"]+)"/g)].map(m => m[1]))
      .toEqual(["ports", "ports-1"]);
    expect([...repeated.toc.matchAll(/href="#([^"]+)"/g)].map(m => m[1]))
      .toEqual(["ports", "ports-1"]);
  });

  it("escapes heading text rather than trusting it as markup", () => {
    const { toc: escaped } = renderDocsHtml("## A <script>x</script> B\n\ntext\n");
    expect(escaped).not.toMatch(/<script>/);
  });

  // The fence transform's three flavors, over synthetic sources: a plain
  // listing, a compiled example (whose IC10 follows it in a <details>), and a
  // rejected one (whose message follows it). What the IC10 *says* is
  // deliberately not pinned - that is the other suites' job.
  it("renders a plain fence as a labeled code group", () => {
    const { content: html } = renderDocsHtml("```icc\nlet x = 1\n```\n");
    expect(html).toMatch(/<div class="code-group">/);
    expect(html).toMatch(/<span class="code-block-label">ICC<\/span>/);
    expect(html).not.toMatch(/<details/);
  });

  it("renders a compiled fence with its output collapsed", () => {
    const { content: html } = renderDocsHtml("```icc {% compile=true %}\nc = 1\n```\n");
    expect(html).toMatch(/<details class="code-block">/);
    expect(html).toMatch(/<span class="code-block-label">IC10<\/span>/);
  });

  it("renders an error fence with its message", () => {
    const { content: html } = renderDocsHtml("```icc {% error=true %}\nlet x = 1\nlet x = 2\n```\n");
    expect(html).toMatch(/<span class="code-block-label">Error<\/span>/);
    expect(html).toMatch(/x was already defined/);
  });

  // A fence that compiles to nothing has no output block; the reader is told
  // so rather than shown an empty <pre> they can't tell from a bug.
  it("says so when an example compiles to nothing", () => {
    const { content: html } = renderDocsHtml("```icc {% compile=true %}\nlet x = a + 1\n```\n");
    expect(html).toMatch(/Compiles to nothing/);
  });

  // The named-fence-as-module path, end to end through the renderer: the
  // importing fence only compiles if `import` resolved against the other one.
  it("resolves an import against a named fence", () => {
    const { content: html } = renderDocsHtml(
      '```icc {% name="lib.icc" %}\nconst Limit = 5\n```\n\n' +
      '```icc {% compile=true %}\nimport Limit from "lib.icc"\nc = Limit\n```\n'
    );
    expect(html).toMatch(/<span class="code-block-label">ICC: lib\.icc<\/span>/);
    expect(text(html)).toMatch(/move c 5/);
  });

  // A fence whose claim is false has to break the render - that is what makes
  // `npm run build` the thing that catches a stale example.
  it("throws when a fence's claim is false", () => {
    expect(() => renderDocsHtml("```icc {% compile=true %}\nlet x = 1\nlet x = 2\n```\n"))
      .toThrow(/failed to compile/);
    expect(() => renderDocsHtml("```icc {% error=true %}\nc = 1\n```\n"))
      .toThrow(/expected a compile error/);
  });

  // Every link that leaves the page opens in a new tab; an in-page anchor
  // does not, since opening a second copy of the docs to reach a heading is
  // not what the reader asked for.
  it("opens outbound links in a new tab and in-page anchors in place", () => {
    const { content: html } = renderDocsHtml("[out](https://example.com) and [in](#legend)\n");
    expect(html).toMatch(/href="https:\/\/example.com"[^>]*target="_blank"/);
    expect(html).toMatch(/<a href="#legend">in<\/a>/);
  });
});

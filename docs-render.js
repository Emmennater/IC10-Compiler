// The documentation page's content, as HTML strings.
//
// This module is the *generator*: source text in, markup out, no DOM and no
// vite-only imports (the markdown arrives as an argument rather than through
// `?raw`), so the same function runs under Node during `vite build` and inside
// the dev server. The prerender plugin in vite.config.js is its only caller.
//
// Nothing in the browser bundle may import this file. Everything expensive on
// the docs page - Markdoc, the compiler, the Lezer grammars behind
// highlight.js - is reachable only from here, so an import from docs.js would
// quietly pull all of it back into the page it was moved out of.
//
// The runtime half of the page (theme, copy buttons, scroll spy) stayed in
// docs.js: what is prerendered is what the markup *is*, not what it does.

import Markdoc from "@markdoc/markdoc";
import { highlightSegments } from "./highlight.js";
import { runDocExample, docModules, locationOf } from "./docs-examples.js";

function codeBlock(code, language, attributes = { "data-language": language }) {
  const children = highlightSegments(code, language).map(({ text, class: cls }) =>
    cls ? new Markdoc.Tag("span", { class: cls }, [text]) : text
  );
  return new Markdoc.Tag("pre", attributes, [new Markdoc.Tag("code", {}, children)]);
}

// The copy button carries no code of its own - it's read back out of the
// `<pre><code>` it sits next to at click time (see initCopyButtons in
// docs.js), so the same delegated listener works for every header regardless
// of label.
function copyButton() {
  return new Markdoc.Tag(
    "button",
    { type: "button", class: "copy-button", title: "Copy code", "aria-label": "Copy code" },
    []
  );
}

// A labeled code block: a small header naming the language, stacked
// directly above the `<pre>` (see .code-group / .code-block in docs.css).
// `collapsible` renders it as a native <details>/<summary> instead of a
// plain <div>, collapsed by default - no JS needed for the expand/collapse
// state, the browser owns it.
function labeledCodeBlock(code, language, label, attributes, collapsible = false) {
  const header = new Markdoc.Tag(collapsible ? "summary" : "div", { class: "code-block-header" }, [
    new Markdoc.Tag("span", { class: "code-block-label" }, [label]),
    copyButton()
  ]);
  const pre = codeBlock(code, language, attributes);
  return new Markdoc.Tag(collapsible ? "details" : "div", { class: "code-block" }, [header, pre]);
}

// The header text of a block. A named fence is a module, so its name is what
// the reader needs to see - the `import` in another block spells that name, and
// nothing else on the page connects the two. Otherwise the language does.
// Spellings the language tag alone doesn't capitalize the way prose does; an
// unknown tag falls back to itself, so a new language needs no entry here.
const LANGUAGE_LABELS = { icc: "ICC", ic10: "IC10" };

function blockLabel(language, name) {
  const lang = LANGUAGE_LABELS[language] || language || "Code"
  return lang + (name ? `: ${name}` : "");
}

// Every code block is a `.code-group`, including the ones with nothing to
// group: the border, the corners and the header are all styled at group level
// (see docs.css), so a lone block outside one would keep its own `<pre>`
// border and lose the header entirely.
function codeGroup(children) {
  return new Markdoc.Tag("div", { class: "code-group" }, children);
}

// Overrides the built-in fence node: same attributes and `<pre>` wrapper,
// but the code is split into highlighted `<span>`s (via the Lezer grammars
// in highlight.js) instead of one escaped text node. `node.attributes.content`
// (not the node's own children) is the raw fence source: a fence node always
// carries a single "text" child too, which is what the default fence schema
// falls back to and is exactly the unhighlighted text this replaces.
//
// Three flavors, and the two interesting ones are both *assertions* - the
// only way documented output can't drift from what the compiler really does:
//
//   ```icc                      plain, highlighted only
//   ```icc {% compile=true %}   compiled; the IC10 output follows it
//   ```icc {% error=true %}     compiled expecting rejection; the message follows
//
// Each throws when the compiler disagrees with the fence - a `compile` example
// that fails, or an `error` example that succeeds. That now breaks the *build*
// rather than the page, which is strictly earlier; the check itself lives in
// runDocExample (docs-examples.js) rather than here, so tests/docs.test.mjs
// can hold the same fences to the same claim without rendering a page. This
// transform only decides what the result *looks* like.
//
// Orthogonal to all three, `name` makes a fence a module another fence can
// `import` from, and titles the block with that name. It is what lets a
// multi-file example be documented as its files rather than as prose about
// files the reader can't see - and, because the importing fence is a `compile`
// one, holds the whole set of them to the compiler.
//
// `removeLabels` resolves labels to absolute line numbers, as the editor's
// export does. It defaults off here because `j loop0` teaches what `j 7`
// doesn't; examples about the final chip-ready form turn it on.
//
// `modules` is every named fence in the document, collected up front by
// renderDocsHtml and closed over here, so an example may import a module
// documented below it.
const fenceFor = modules => ({
  ...Markdoc.nodes.fence,
  attributes: {
    ...Markdoc.nodes.fence.attributes,
    compile: { type: Boolean, render: false, default: false },
    error: { type: Boolean, render: false, default: false },
    removeLabels: { type: Boolean, render: false, default: false },
    name: { type: String, render: false }
  },
  transform(node, config) {
    const attributes = node.transformAttributes(config);
    const code = node.attributes.content;
    const language = node.attributes.language;
    const { compile: wantCompile, error: wantError, removeLabels, name } = node.attributes;
    const label = blockLabel(language, name);

    if (!wantCompile && !wantError) {
      return codeGroup([labeledCodeBlock(code, language, label, attributes)]);
    }

    const { ic10, message } = runDocExample({
      code,
      compile: wantCompile,
      error: wantError,
      removeLabels,
      modules,
      where: locationOf(node.lines)
    });

    if (message !== undefined) {
      return codeGroup([
        labeledCodeBlock(code, language, label, attributes),
        labeledCodeBlock(message, "", "Error", { class: "code-error" })
      ]);
    }

    return codeGroup([
      labeledCodeBlock(code, language, label, attributes),
      // An example that compiles to nothing has no output block to expand;
      // saying so beats an empty <pre> the reader can't tell from a bug.
      ic10 === ""
        ? new Markdoc.Tag("div", { class: "code-block code-empty" }, ["Compiles to nothing"])
        : labeledCodeBlock(ic10, "ic10", "IC10", undefined, true)
    ]);
  }
});

// Overrides the built-in link node so every link that leaves the page opens
// in a new tab: `rel="noopener noreferrer"` because `target="_blank"`
// otherwise hands the new page an unguarded `window.opener` back into this
// one. A `#anchor` is excluded - it points at a heading on this very page,
// and opening a second copy of the docs to reach it is not what the reader
// asked for.
const link = {
  ...Markdoc.nodes.link,
  transform(node, config) {
    const attributes = node.transformAttributes(config);
    const children = node.transformChildren(config);
    const external = !String(attributes.href ?? "").startsWith("#");
    return new Markdoc.Tag(
      "a",
      external ? { ...attributes, target: "_blank", rel: "noopener noreferrer" } : attributes,
      children
    );
  }
};

// `{% tok kind="keyword" %}keyword{% /tok %}` - used by the legend to show a
// token class's actual color without hand-picking one out of theme.js.
const tok = {
  render: "span",
  attributes: {
    kind: { type: String, required: true, render: false }
  },
  transform(node, config) {
    const children = node.transformChildren(config);
    return new Markdoc.Tag("span", { class: `tok-${node.attributes.kind}` }, children);
  }
};

// `{% callout type="warn" %} … {% /callout %}` - an aside the reader should
// not scroll past. `type` only picks a color class (see .callout in docs.css);
// the title is the prose's job, so nothing here invents one.
const callout = {
  render: "div",
  attributes: {
    type: { type: String, default: "note", matches: ["note", "warn"], render: false }
  },
  transform(node, config) {
    const children = node.transformChildren(config);
    return new Markdoc.Tag("div", { class: `callout callout-${node.attributes.type}` }, children);
  }
};

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The visible text of a heading: its text and inline-code descendants. */
function headingText(node) {
  let text = "";
  for (const child of node.walk()) {
    const content = child.attributes?.content;
    if (typeof content === "string") text += content;
  }
  return text;
}

// Markdoc's default heading transform emits no `id`, and the anchors are what
// make a section linkable at all - so they are part of the markup rather than
// something JS adds on load.
//
// The table of contents is collected here, as a side effect, rather than by a
// second walk of the tree: `Markdoc.transform` resolves the tree first, and
// `Node.resolve` returns *copies* of every node, so a map keyed on the parsed
// nodes never matches the ones a transform is handed - which showed up as
// every heading rendering without its id while the TOC linked to all of them.
// Collecting as we go also means the de-dup counter is only maintained once,
// so `#legend-1` cannot end up on a different heading than the link to it.
// The transform is the document-order traversal, so `entries` comes out in
// page order.
const headingFor = entries => ({
  ...Markdoc.nodes.heading,
  transform(node, config) {
    const attributes = node.transformAttributes(config);
    const children = node.transformChildren(config);
    const level = Number(node.attributes.level);

    // Only h2/h3 reach the TOC (h1 is the page title), and a heading outside
    // that range keeps Markdoc's plain rendering.
    if (level !== 2 && level !== 3) {
      return new Markdoc.Tag(`h${node.attributes.level}`, attributes, children);
    }

    const text = headingText(node);
    const base = slugify(text);
    const taken = entries.filter(entry => entry.base === base).length;
    const id = taken === 0 ? base : `${base}-${taken}`;

    entries.push({ level, text, id, base });
    return new Markdoc.Tag(`h${level}`, { ...attributes, id }, children);
  }
});

// Built as Markdoc tags and run through the same renderer as the content, so
// heading text is escaped by the thing that already knows how, rather than by
// a second hand-rolled escape here.
function tocTag(entries) {
  return new Markdoc.Tag("ul", {}, entries.map(({ level, text, id }) =>
    new Markdoc.Tag("li", { class: `toc-level-${level}` }, [
      new Markdoc.Tag("a", { href: `#${id}` }, [text])
    ])
  ));
}

/**
 * Render `source` (the contents of docs.markdoc.md) into the two markup
 * strings the page is assembled from: `content` for #docs-content and `toc`
 * for #docs-toc.
 *
 * Throws when a fence's `compile`/`error` claim disagrees with the compiler,
 * via runDocExample - so the caller decides whether that fails a build or a
 * dev-server request, and neither can render a page with a stale claim on it.
 */
export function renderDocsHtml(source) {
  const modules = docModules(source);
  // Filled in by the heading transform during the call below, so the TOC is
  // rendered second - it is made of what the content transform saw.
  const headings = [];

  const content = Markdoc.transform(Markdoc.parse(source), {
    nodes: { fence: fenceFor(modules), heading: headingFor(headings), link },
    tags: { tok, callout }
  });

  return {
    content: Markdoc.renderers.html(content),
    toc: Markdoc.renderers.html(tocTag(headings))
  };
}

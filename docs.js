import Markdoc from "@markdoc/markdoc";
import docsSource from "./docs.markdoc.md?raw";
import { highlightSegments } from "./highlight.js";
import { loadTheme, applyTheme, themeNames, themeName } from "./theme.js";
import { setupDropdown, dropdownItem } from "./dropdown.js";
import { compile, CompileError } from "./compiler/index.ts";
import { getAST } from "./compiler/ast.ts";

loadTheme();

function codeBlock(code, language, attributes = { "data-language": language }) {
  const children = highlightSegments(code, language).map(({ text, class: cls }) =>
    cls ? new Markdoc.Tag("span", { class: cls }, [text]) : text
  );
  return new Markdoc.Tag("pre", attributes, [new Markdoc.Tag("code", {}, children)]);
}

// A labeled code block: a small header naming the language, stacked
// directly above the `<pre>` (see .code-group / .code-block in docs.css).
// `collapsible` renders it as a native <details>/<summary> instead of a
// plain <div>, collapsed by default — no JS needed for the expand/collapse
// state, the browser owns it.
function labeledCodeBlock(code, language, label, attributes, collapsible = false) {
  const header = new Markdoc.Tag(collapsible ? "summary" : "div", { class: "code-block-header" }, [label]);
  const pre = codeBlock(code, language, attributes);
  return new Markdoc.Tag(collapsible ? "details" : "div", { class: "code-block" }, [header, pre]);
}

// Overrides the built-in fence node: same attributes and `<pre>` wrapper,
// but the code is split into highlighted `<span>`s (via the Lezer grammars
// in highlight.js) instead of one escaped text node. `node.attributes.content`
// (not the node's own children) is the raw fence source: a fence node always
// carries a single "text" child too, which is what the default fence schema
// falls back to and is exactly the unhighlighted text this replaces.
//
// A fence tagged ```icc {% compile=true %} is additionally run through the
// real compiler — the same `compile(getAST(...))` call main.js makes — and
// followed by its IC10 output. That's the only way the "compiles to" example
// can't drift from what the compiler actually emits: a compile error here
// throws, which breaks the docs page instead of leaving stale output on it.
const fence = {
  ...Markdoc.nodes.fence,
  attributes: {
    ...Markdoc.nodes.fence.attributes,
    compile: { type: Boolean, render: false, default: false }
  },
  transform(node, config) {
    const attributes = node.transformAttributes(config);
    const code = node.attributes.content;
    const language = node.attributes.language;

    if (!node.attributes.compile) return codeBlock(code, language, attributes);

    let ic10;
    try {
      ic10 = compile(getAST(code), { removeLabels: true });
    } catch (e) {
      const where = node.lines.length ? ` (docs.markdoc.md:${node.lines[0] + 1})` : "";
      throw new Error(`Doc example failed to compile${where}: ${e instanceof CompileError ? e.message : e}`);
    }

    return new Markdoc.Tag("div", { class: "code-group" }, [
      labeledCodeBlock(code, language, "ICC", attributes),
      labeledCodeBlock(ic10, "ic10", "IC10", undefined, true)
    ]);
  }
};

// Overrides the built-in link node so every markdown link opens in a new
// tab: `rel="noopener noreferrer"` because `target="_blank"` otherwise
// hands the new page an unguarded `window.opener` back into this one.
const link = {
  ...Markdoc.nodes.link,
  transform(node, config) {
    const attributes = node.transformAttributes(config);
    const children = node.transformChildren(config);
    return new Markdoc.Tag("a", { ...attributes, target: "_blank", rel: "noopener noreferrer" }, children);
  }
};

// `{% tok kind="keyword" %}keyword{% /tok %}` — used by the legend to show a
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

function renderDocs() {
  const ast = Markdoc.parse(docsSource);
  const content = Markdoc.transform(ast, { nodes: { fence, link }, tags: { tok } });
  document.querySelector("#docs-content").innerHTML = Markdoc.renderers.html(content);
}

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Builds the left-hand table of contents from the h2/h3s Markdoc just
// rendered into #docs-content. The default heading transform emits no
// `id`, so one is assigned here (de-duped against repeats of the same
// heading text) and shared between the anchor and the link that targets it.
function buildToc() {
  const content = document.querySelector("#docs-content");
  const toc = document.querySelector("#docs-toc");
  const headings = content.querySelectorAll("h2, h3");
  const seen = new Map();
  const list = document.createElement("ul");

  for (const heading of headings) {
    const base = slugify(heading.textContent);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    heading.id = count === 0 ? base : `${base}-${count}`;

    const item = document.createElement("li");
    item.className = `toc-level-${heading.tagName[1]}`;
    const link = document.createElement("a");
    link.href = `#${heading.id}`;
    link.textContent = heading.textContent;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    item.appendChild(link);
    list.appendChild(item);
  }

  toc.replaceChildren(list);
}

function initThemeToggle() {
  const themeToggle = document.querySelector("#theme-toggle");
  const themeList = document.querySelector("#theme-list");

  const showTheme = () => { themeToggle.textContent = `${themeName()} ▾`; };

  const menu = setupDropdown(themeToggle, themeList, () => {
    themeList.innerHTML = "";
    const current = themeName();

    for (const name of themeNames) {
      themeList.appendChild(dropdownItem(name, name === current, () => {
        menu.close();
        applyTheme(name);
        showTheme();
      }));
    }
  });

  showTheme();
}

renderDocs();
buildToc();
initThemeToggle();

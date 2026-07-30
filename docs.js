import Markdoc from "@markdoc/markdoc";
import docsSource from "./docs.markdoc.md?raw";
import clipboardIconUrl from "./assets/clipboard-icon.svg";
import { highlightSegments } from "./highlight.js";
import { loadTheme, applyTheme, themeNames, themeName } from "./theme.js";
import { setupDropdown, dropdownItem } from "./dropdown.js";
import { runDocExample, docModules, locationOf } from "./docs-examples.js";

loadTheme();

// The copy button's icon is applied as a CSS mask (see .copy-button in
// docs.css) rather than inlined as SVG markup, so the button can be colored
// with the theme's currentColor regardless of the colors baked into the
// source file. Set once as a root custom property, the same way theme.js
// writes --theme-* values, rather than duplicating the imported URL into an
// inline style on every button.
document.documentElement.style.setProperty("--copy-icon-url", `url("${clipboardIconUrl}")`);

function codeBlock(code, language, attributes = { "data-language": language }) {
  const children = highlightSegments(code, language).map(({ text, class: cls }) =>
    cls ? new Markdoc.Tag("span", { class: cls }, [text]) : text
  );
  return new Markdoc.Tag("pre", attributes, [new Markdoc.Tag("code", {}, children)]);
}

// The copy button carries no code of its own - it's read back out of the
// `<pre><code>` it sits next to at click time (see initCopyButtons), so the
// same delegated listener works for every header regardless of label.
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
  if (name) return name;
  return LANGUAGE_LABELS[language] || language || "Code";
}

// Every code block is a `.code-group`, including the ones with nothing to
// group: the border, the corners and the header are all styled at group level
// (see docs.css), so a lone block outside one would keep its own `<pre>`
// border and lose the header entirely.
function codeGroup(children) {
  return new Markdoc.Tag("div", { class: "code-group" }, children);
}

// Every named fence on the page, as what an example's `import` resolves
// against. Collected once from the same source renderDocs parses.
const modules = docModules(docsSource);

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
// that fails, or an `error` example that succeeds - which breaks the docs page
// loudly instead of leaving a stale claim standing on it. That check lives in
// runDocExample (docs-examples.js) rather than here, so tests/docs.test.mjs
// can hold the same fences to the same claim without rendering a page; this
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
const fence = {
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
};

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

function renderDocs() {
  const ast = Markdoc.parse(docsSource);
  const content = Markdoc.transform(ast, { nodes: { fence, link }, tags: { tok, callout } });
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
  const sections = [];

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
    sections.push({ heading, link });
  }

  toc.replaceChildren(list);
  return sections;
}

// Highlights whichever TOC entry corresponds to the section currently at the
// top of the viewport. `#docs-content` scrolls itself (see docs.css), so the
// "current" heading is the last one whose top has scrolled above a small
// margin - not whatever IntersectionObserver's default viewport root would
// see, which is the outer page and never fires. Positions are read fresh
// each tick with getBoundingClientRect rather than cached via offsetTop,
// since offsetTop is relative to the nearest positioned ancestor, not
// necessarily #docs-content itself.
function initTocScrollSpy(sections) {
  if (sections.length === 0) return;
  const content = document.querySelector("#docs-content");
  const margin = 16;
  let ticking = false;

  function updateActive() {
    ticking = false;
    const contentTop = content.getBoundingClientRect().top;
    let current = sections[0];
    for (const section of sections) {
      const offset = section.heading.getBoundingClientRect().top - contentTop;
      if (offset <= margin) current = section;
      else break;
    }
    for (const section of sections) {
      section.link.classList.toggle("active", section === current);
    }
  }

  content.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateActive);
  }, { passive: true });

  updateActive();
}

// One delegated listener rather than one per button: Markdoc renders headers
// via innerHTML (see renderDocs), so there's no per-button closure to attach
// at creation time anyway. Some headers are <summary> elements (the
// collapsible IC10 block), where a click on the button would otherwise also
// toggle the parent <details> open/closed - stopPropagation keeps that
// native behavior from firing.
function initCopyButtons() {
  const content = document.querySelector("#docs-content");

  content.addEventListener("click", (e) => {
    const button = e.target.closest(".copy-button");
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();

    const code = button.closest(".code-block")?.querySelector("pre code");
    if (!code) return;

    navigator.clipboard.writeText(code.textContent).then(() => {
      button.classList.add("copied");
      setTimeout(() => button.classList.remove("copied"), 1200);
    });
  });
}

function initThemeToggle() {
  const themeToggle = document.querySelector("#theme-toggle");
  const themeList = document.querySelector("#theme-list");
  const themeGroup = themeToggle.closest(".dropdown");

  // #theme-list is styled to exactly match #theme-toggle's width. Both use
  // the same monospace font, so sizing the toggle (in `ch`) to the longest
  // theme name + " ▾" guarantees every entry fits without truncating, no
  // matter which theme is currently selected.
  const widestName = Math.max(...themeNames.map(name => name.length));
  themeToggle.style.minWidth = `${widestName + 2}ch`;

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
  }, themeGroup);

  showTheme();
}

renderDocs();
initTocScrollSpy(buildToc());
initCopyButtons();
initThemeToggle();

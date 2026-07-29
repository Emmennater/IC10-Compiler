import Markdoc from "@markdoc/markdoc";
import docsSource from "./docs.markdoc.md?raw";
import { highlightSegments } from "./highlight.js";
import { loadTheme, applyTheme, themeNames, themeName } from "./theme.js";
import { setupDropdown, dropdownItem } from "./dropdown.js";

loadTheme();

// Overrides the built-in fence node: same attributes and `<pre>` wrapper,
// but the code is split into highlighted `<span>`s (via the Lezer grammars
// in highlight.js) instead of one escaped text node. `node.attributes.content`
// (not the node's own children) is the raw fence source: a fence node always
// carries a single "text" child too, which is what the default fence schema
// falls back to and is exactly the unhighlighted text this replaces.
const fence = {
  ...Markdoc.nodes.fence,
  transform(node, config) {
    const attributes = node.transformAttributes(config);
    const code = node.attributes.content;
    const language = node.attributes.language;

    const children = highlightSegments(code, language).map(({ text, class: cls }) =>
      cls ? new Markdoc.Tag("span", { class: cls }, [text]) : text
    );

    return new Markdoc.Tag("pre", attributes, [new Markdoc.Tag("code", {}, children)]);
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
  const content = Markdoc.transform(ast, { nodes: { fence }, tags: { tok } });
  document.querySelector("#docs-content").innerHTML = Markdoc.renderers.html(content);
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
initThemeToggle();

import { defineConfig, runnerImport } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Two pages, so `vite build` needs both named as entries: with the default
// single `index.html` input the editor built fine and docs.html was simply
// absent from dist/, along with every module only it imports (markdoc, the
// docs stylesheet). The dev server never showed this - it serves any .html
// in the root on request - so the gap only existed in the built site.
//
// The keys name the emitted chunks, not the routes; the pages keep their own
// filenames because the input paths are what vite mirrors into dist/.
const root = fileURLToPath(new URL(".", import.meta.url));
const page = name => fileURLToPath(new URL(name, import.meta.url));

const DOCS_SOURCE = "docs.markdoc.md";

// Renders docs.markdoc.md into docs.html - the content, the table of contents,
// and the theme colors - so the page arrives as markup instead of as a script
// that builds it. `transformIndexHtml` is what makes this one code path: vite
// runs it per request in the dev server and once over the bundle in
// `vite build`, so the dev page is generated on every reload and the built page
// is generated exactly once, from the same call.
//
// Prerendering also moves the docs' `compile`/`error` fences from a claim
// checked when a browser happens to load the page to one checked by
// `npm run build`. A stale example now fails the build.
function prerenderDocs() {
  let devServer;

  // docs-render.js reaches the compiler through `.ts` imports and pulls in
  // Markdoc and the Lezer parsers, so it is loaded through vite rather than by
  // Node directly - which also keeps this working if the compiler ever uses a
  // TypeScript construct Node's own type stripping refuses.
  //
  // In the dev server that means the running server's module runner, so an edit
  // to the compiler invalidates the module and the next request re-renders with
  // it. `vite build` has no server, so it uses runnerImport, which loads a
  // module through vite's pipeline and tears its environment down again;
  // `configFile: false` because loading this config would register this plugin
  // recursively.
  async function load(url) {
    if (devServer) return devServer.ssrLoadModule(url);
    const { module } = await runnerImport(url, { root, configFile: false, logLevel: "warn" });
    return module;
  }

  // The default theme as a stylesheet rule, plus one rule per theme keyed on
  // the `data-theme` the head script sets below. Two reasons it is generated
  // from theme.js rather than written into docs.css: the colors then have a
  // single source (applyTheme reads the same map), and the `:root` block is
  // what colors the page for a reader with JS off, who never reaches
  // applyTheme at all.
  function themeStyles(themes, defaultTheme) {
    const block = (selector, colors) => {
      const properties = Object.entries(colors)
        .map(([key, value]) => `      --theme-${key}: ${value};`)
        .join("\n");
      return `    ${selector} {\n${properties}\n    }`;
    };

    return [
      block(":root", themes[defaultTheme]),
      ...Object.entries(themes).map(([name, colors]) =>
        block(`:root[data-theme="${name}"]`, colors)
      )
    ].join("\n");
  }

  // Applies the stored theme before first paint. It has to be inline and
  // blocking - a module script is deferred, so the docs would paint in the
  // default theme and then snap to the reader's, which is only invisible today
  // because there is no content to paint until the module runs.
  //
  // It sets an attribute rather than the fourteen custom properties applyTheme
  // writes, so the colors stay in the generated stylesheet above and this stays
  // one line. An unknown or absent stored name matches no `[data-theme]` rule
  // and falls through to `:root`, so there is nothing to validate here.
  function themeScript(key, defaultTheme) {
    return `document.documentElement.dataset.theme = ` +
      `localStorage.getItem(${JSON.stringify(key)}) || ${JSON.stringify(defaultTheme)};`;
  }

  function fill(html, marker, markup) {
    const comment = `<!--${marker}-->`;
    if (!html.includes(comment)) {
      throw new Error(
        `docs.html is missing the ${comment} marker, so there is nowhere to ` +
        `render ${DOCS_SOURCE} into. See prerenderDocs in vite.config.js.`
      );
    }
    return html.replace(comment, markup);
  }

  return {
    name: "prerender-docs",

    configureServer(server) {
      devServer = server;
    },

    // transformIndexHtml re-renders on request, so a reload is all that is
    // needed - but only a reload the browser is told to perform. Everything the
    // prerender reads was deliberately taken out of the page's module graph, so
    // the client environment sees no module change and says nothing.
    //
    // The generator's own dependencies are exactly the ssr environment's module
    // graph, which `load` populates and vite invalidates on change - so `ssr`
    // reporting any affected module is the signal, and it covers
    // docs-render.js, docs-examples.js, highlight.js, theme.js, the compiler
    // and the Lezer parsers without naming any of them. Naming them was the
    // bug: the old watcher listed only `compiler/`, so an edit to the generator
    // itself re-rendered on the next request but nothing ever asked for one.
    //
    // docs.markdoc.md is the one input that is not a module - it is read with
    // readFileSync - so it stays an explicit check.
    hotUpdate({ file, modules }) {
      if (this.environment.name !== "ssr") return;
      if (!modules.length && !file.endsWith(`/${DOCS_SOURCE}`)) return;
      devServer.environments.client.hot.send({ type: "full-reload", path: "/docs.html" });
    },

    transformIndexHtml: {
      order: "pre",
      async handler(html, ctx) {
        if (!ctx.filename.replace(/\\/g, "/").endsWith("/docs.html")) return;

        const [{ renderDocsHtml }, { themes, THEME_KEY, DEFAULT_THEME }] = await Promise.all([
          load("/docs-render.js"),
          load("/theme.js")
        ]);

        const { content, toc } = renderDocsHtml(readFileSync(page(DOCS_SOURCE), "utf8"));

        return {
          html: fill(fill(html, "docs-toc", toc), "docs-content", content),
          tags: [
            {
              tag: "style",
              injectTo: "head-prepend",
              children: `\n${themeStyles(themes, DEFAULT_THEME)}\n  `
            },
            {
              tag: "script",
              injectTo: "head",
              children: themeScript(THEME_KEY, DEFAULT_THEME)
            }
          ]
        };
      }
    }
  };
}

export default defineConfig({
  plugins: [prerenderDocs()],
  build: {
    rollupOptions: {
      input: {
        main: page("index.html"),
        docs: page("docs.html"),
      },
    },
  },
});

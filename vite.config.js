import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Two pages, so `vite build` needs both named as entries: with the default
// single `index.html` input the editor built fine and docs.html was simply
// absent from dist/, along with every module only it imports (markdoc, the
// docs stylesheet). The dev server never showed this - it serves any .html
// in the root on request - so the gap only existed in the built site.
//
// The keys name the emitted chunks, not the routes; the pages keep their own
// filenames because the input paths are what vite mirrors into dist/.
const page = name => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: page("index.html"),
        docs: page("docs.html"),
      },
    },
  },
});

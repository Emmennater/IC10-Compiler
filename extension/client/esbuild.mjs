// Bundles the extension client -- and vscode-languageclient -- into a single
// out/extension.js, so client/node_modules doesn't need to ship in the .vsix.
//
// `vscode` is marked external: it's the editor API, injected by the VS Code
// runtime at load time, and must never be bundled. (This is the one difference
// from the server bundle, which never imports "vscode".)

import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "out/extension.js",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[esbuild] watching client for changes...");
} else {
  await esbuild.build(options);
}

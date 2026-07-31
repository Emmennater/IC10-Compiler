// Bundles the language server -- and the IC10 compiler it imports -- into a
// single out/server.js that plain Node can run.
//
// esbuild is used instead of `tsc` because the compiler is authored with
// explicit `.ts` import specifiers and pulls in the generated lezer parser plus
// `@lezer/*`. A bundler resolves all of that and inlines it; `tsc` alone cannot.
// The server never imports "vscode" (only the client does), so everything can be
// bundled with no externals.
//
// `tsconfig` is set so esbuild honours the `paths` alias that maps
// `ic10-compiler/*` to the sibling compiler source in this repo.

import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "out/server.js",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[esbuild] watching server + compiler for changes...");
} else {
  await esbuild.build(options);
}

import { build, context } from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** The extension host runs in Node and must not bundle the `vscode` module. */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** The webview runs in a browser context with no Node builtins available. */
const webviewConfig = {
  entryPoints: ["webview/main.ts"],
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (watch) {
  for (const config of [extensionConfig, webviewConfig]) {
    const ctx = await context(config);
    await ctx.watch();
  }
  console.log("watching...");
} else {
  await Promise.all([build(extensionConfig), build(webviewConfig)]);
}

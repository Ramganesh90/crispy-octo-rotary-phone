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

/**
 * Development-only harness host: runs the real engine in a browser so the
 * resolver UI can be previewed and screenshotted without launching VS Code.
 * Excluded from the published package by .vscodeignore.
 */
const previewConfig = {
  ...webviewConfig,
  entryPoints: ["dev/preview-host.ts"],
  outfile: "dist/preview-host.js",
  minify: false,
};

const configs = production
  ? [extensionConfig, webviewConfig]
  : [extensionConfig, webviewConfig, previewConfig];

if (watch) {
  for (const config of configs) {
    const ctx = await context(config);
    await ctx.watch();
  }
  console.log("watching...");
} else {
  await Promise.all(configs.map(build));
}

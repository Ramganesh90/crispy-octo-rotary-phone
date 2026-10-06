/**
 * Launches a real VS Code and runs the integration suite inside it.
 *
 * This is the only way to exercise the parts that need an actual editor:
 * activation, the tree view, the custom editor, and the commands. It
 * downloads VS Code on first run, so it needs network access and does not
 * run in sandboxes that block that — CI is where it earns its keep.
 */

import { runTests } from "@vscode/test-electron";
import { resolve } from "node:path";

async function main(): Promise<void> {
  const extensionDevelopmentPath = resolve(__dirname, "..", "..", "..");
  const extensionTestsPath = resolve(__dirname, "suite", "integration.index");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      "--disable-extensions", // except ours and the built-in git extension
      "--disable-gpu",
      "--no-sandbox",
    ],
  });
}

main().catch((error) => {
  console.error("Integration tests failed:", error);
  process.exit(1);
});

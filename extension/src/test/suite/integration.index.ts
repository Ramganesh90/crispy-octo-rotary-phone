/**
 * Entry point VS Code calls inside the test instance. Runs the integration
 * tests with Node's own test runner so the suite needs no extra framework.
 */

import { run as runNodeTests } from "node:test";
import { resolve } from "node:path";

export async function run(): Promise<void> {
  const file = resolve(__dirname, "integration.test.js");

  const failures: string[] = [];
  // `isolation: "none"` is required, not an optimisation: the default spawns
  // a child process, which would not be the extension host and so could not
  // resolve the `vscode` module the suite imports.
  const stream = runNodeTests({
    files: [file],
    concurrency: 1,
    timeout: 120_000,
    isolation: "none",
  });

  stream.on("test:fail", (event: { name: string; details?: { error?: Error } }) => {
    failures.push(`${event.name}: ${event.details?.error?.message ?? "failed"}`);
  });
  stream.on("test:pass", (event: { name: string }) => {
    console.log(`  ok   ${event.name}`);
  });

  await new Promise<void>((done, fail) => {
    stream.on("end", () => done());
    stream.on("error", fail);
    stream.resume();
  });

  if (failures.length > 0) {
    throw new Error(`${failures.length} integration test(s) failed:\n${failures.join("\n")}`);
  }
}

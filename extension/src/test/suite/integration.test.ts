/**
 * The parts that only a real VS Code can exercise: activation, the tree view,
 * the commands, the custom editor, and the apply-and-stage round trip.
 *
 * Runs inside a VS Code instance opened on a scratch repository built with a
 * real conflicted merge, the same way the Node-side git tests do it.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as vscode from "vscode";

import { analyze, type ConflictFile, findConflicts } from "../../conflicts";
import { stageResolved } from "../../git/stages";
import { ConflictTreeProvider } from "../../ui/ConflictTreeProvider";

const EXTENSION_ID = "ramganesh90.structural-merge-resolver";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" });
}

function write(file: string, content: string): void {
  writeFileSync(join(repo, file), content, "utf8");
}

function read(file: string): string {
  return readFileSync(join(repo, file), "utf8");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for a condition the editor reaches asynchronously. */
async function eventually(
  describe: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${describe}`);
    }
    await sleep(250);
  }
}

before(async () => {
  repo = mkdtempSync(join(tmpdir(), "smr-integration-"));
  git("init", "-q", "-b", "main");

  write(
    "package.json",
    '{\n  "name": "demo",\n  "version": "1.0.0",\n  "dependencies": {\n    "react": "18.0.0"\n  }\n}\n',
  );
  write(".gitignore", "*.log\n");
  write("notes.txt", "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  git("checkout", "-qb", "feature");
  write(
    "package.json",
    '{\n  "name": "demo",\n  "version": "2.0.0",\n  "dependencies": {\n    "react": "18.0.0",\n    "zod": "3.22.0"\n  }\n}\n',
  );
  write(".gitignore", "*.log\ndist/\n");
  write("notes.txt", "theirs\n");
  git("commit", "-qam", "theirs");

  git("checkout", "-q", "main");
  write(
    "package.json",
    '{\n  "name": "demo",\n  "version": "1.1.0",\n  "dependencies": {\n    "react": "18.2.0",\n    "vite": "5.0.0"\n  }\n}\n',
  );
  write(".gitignore", "*.log\ncoverage/\n");
  write("notes.txt", "ours\n");
  git("commit", "-qam", "ours");

  try {
    git("merge", "--no-edit", "feature");
    throw new Error("expected the merge to conflict");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("expected")) {
      throw error;
    }
  }

  // Open the repo as the workspace folder the extension will look at.
  const uri = vscode.Uri.file(repo);
  if (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath !== repo) {
    vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, {
      uri,
    });
    await sleep(1500);
  }
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("the extension is present and activates", async () => {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} not found`);
  await extension.activate();
  assert.equal(extension.isActive, true);
});

test("it registers its commands", async () => {
  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    "structuralMerge.resolve",
    "structuralMerge.refresh",
    "structuralMerge.resolveAllClean",
    "structuralMerge.openInTextEditor",
  ]) {
    assert.ok(commands.includes(id), `missing command ${id}`);
  }
});

test("it finds the conflicted files and classifies them", async () => {

  let conflicts: ConflictFile[] = [];
  await eventually("conflicts to be discovered", async () => {
    conflicts = await findConflicts();
    return conflicts.length >= 3;
  });

  const byPath = new Map(conflicts.map((c: ConflictFile) => [c.path, c]));
  assert.equal(byPath.get("package.json")?.state.kind, "structural");
  assert.equal(byPath.get(".gitignore")?.state.kind, "clean");
  assert.equal(byPath.get("notes.txt")?.state.kind, "text");
});

test("the tree view reports the conflicts", async () => {
  // The view is created on activation; asking the provider directly is the
  // closest a test can get to what the sidebar renders.
  const provider = new ConflictTreeProvider();
  const children = await provider.getChildren();
  assert.ok(children.length >= 3, `expected 3 rows, got ${children.length}`);
  provider.dispose();
});

test("the custom editor opens for a conflicted file", async () => {
  const uri = vscode.Uri.file(join(repo, "package.json"));
  await vscode.commands.executeCommand(
    "vscode.openWith",
    uri,
    "structuralMerge.resolver",
  );
  await sleep(1500);
  assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab, "no tab opened");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
});

test("resolving the cleanly mergeable files stages them", async () => {
  const conflicts = await findConflicts();
  const clean = conflicts.find((c: ConflictFile) => c.path === ".gitignore");
  assert.ok(clean, ".gitignore should merge cleanly");

  const { engine, doc } = await analyze(clean.repo, clean.path, clean.format!);
  const text = engine.serialize(doc);

  // Both branches' additions survive, the shared line stays.
  assert.deepEqual(text.trimEnd().split("\n").sort(), [
    "*.log",
    "coverage/",
    "dist/",
  ]);

  writeFileSync(join(repo, ".gitignore"), text, "utf8");
  await stageResolved(repo, ".gitignore");

  const unmerged = git("ls-files", "-u", "--", ".gitignore");
  assert.equal(unmerged.trim(), "", ".gitignore should no longer be unmerged");
  assert.equal(read(".gitignore"), text);
});

test("a structural merge keeps both branches' new dependencies", async () => {
  const conflicts = await findConflicts();
  const target = conflicts.find((c: ConflictFile) => c.path === "package.json");
  assert.ok(target);

  const { engine, doc } = await analyze(target.repo, target.path, target.format!);

  // version and react conflict; both added dependencies merge cleanly.
  assert.equal(doc.conflictCount, 2, "version and react both changed on both sides");

  for (const node of doc.root.flatMap((n) => [n, ...(n.children ?? [])])) {
    if (node.status === "conflict" && !node.children) {
      node.resolution = { kind: "side", side: "theirs" };
    }
  }

  const merged = JSON.parse(engine.serialize(doc)) as {
    version: string;
    dependencies: Record<string, string>;
  };
  assert.equal(merged.version, "2.0.0");
  assert.equal(merged.dependencies.react, "18.0.0");
  assert.equal(merged.dependencies.vite, "5.0.0", "our addition survives");
  assert.equal(merged.dependencies.zod, "3.22.0", "their addition survives");
});

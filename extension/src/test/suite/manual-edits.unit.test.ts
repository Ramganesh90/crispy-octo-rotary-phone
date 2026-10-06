/**
 * Detecting that a conflicted file was edited by hand after the merge.
 *
 * Runs against real repositories with real conflicts: `hasManualEdits` shells
 * out to `git merge-file`, so only a real git can tell us whether it works.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { hasManualEdits, readConflictStages } from "../../git/stages";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
};

const repos: string[] = [];
after(() => repos.forEach((r) => rmSync(r, { recursive: true, force: true })));

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" });
}

/** A repo mid-merge, with `file` conflicted and markers on disk. */
function conflicted(file: string, base: string, ours: string, theirs: string): string {
  const repo = mkdtempSync(join(tmpdir(), "smr-edits-"));
  repos.push(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, file), base);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");

  git(repo, "checkout", "-qb", "feature");
  writeFileSync(join(repo, file), theirs);
  git(repo, "commit", "-qam", "theirs");

  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, file), ours);
  git(repo, "commit", "-qam", "ours");
  try {
    git(repo, "merge", "--no-edit", "feature");
  } catch {
    // conflicts are the point
  }
  return repo;
}

const BASE = '{\n  "v": 1\n}\n';
const OURS = '{\n  "v": 2\n}\n';
const THEIRS = '{\n  "v": 3\n}\n';

test("an untouched conflicted file is not reported as edited", async () => {
  const repo = conflicted("config.json", BASE, OURS, THEIRS);
  const stages = await readConflictStages(repo, "config.json");
  const onDisk = readFileSync(join(repo, "config.json"), "utf8");

  assert.ok(onDisk.includes("<<<<<<<"), "precondition: markers are on disk");
  assert.equal(await hasManualEdits(repo, onDisk, stages), false);
});

test("a file resolved by hand is reported as edited", async () => {
  const repo = conflicted("config.json", BASE, OURS, THEIRS);
  const stages = await readConflictStages(repo, "config.json");

  // What someone does when they start fixing the markers themselves.
  assert.equal(await hasManualEdits(repo, '{\n  "v": 4\n}\n', stages), true);
});

test("an edit around the markers is reported", async () => {
  const repo = conflicted("config.json", BASE, OURS, THEIRS);
  const stages = await readConflictStages(repo, "config.json");
  const onDisk = readFileSync(join(repo, "config.json"), "utf8");

  assert.equal(await hasManualEdits(repo, onDisk + "\n// a note\n", stages), true);
});

test("differing marker labels alone are not an edit", async () => {
  const repo = conflicted("config.json", BASE, OURS, THEIRS);
  const stages = await readConflictStages(repo, "config.json");
  const onDisk = readFileSync(join(repo, "config.json"), "utf8");

  // git labels markers with branch names; ours are generated separately, so
  // label differences must not read as a hand edit.
  const relabelled = onDisk
    .replace(/^<<<<<<<.*$/m, "<<<<<<< some/other/label")
    .replace(/^>>>>>>>.*$/m, ">>>>>>> another/label");

  assert.equal(await hasManualEdits(repo, relabelled, stages), false);
});

test("a trailing-newline difference alone is not an edit", async () => {
  const repo = conflicted("config.json", BASE, OURS, THEIRS);
  const stages = await readConflictStages(repo, "config.json");
  const onDisk = readFileSync(join(repo, "config.json"), "utf8");

  assert.equal(await hasManualEdits(repo, onDisk.trimEnd(), stages), false);
});

test("it stays quiet rather than crying wolf when git cannot be asked", async () => {
  const stages = { base: BASE, ours: OURS, theirs: THEIRS };
  assert.equal(await hasManualEdits("/nonexistent-repo-path", "anything", stages), false);
});

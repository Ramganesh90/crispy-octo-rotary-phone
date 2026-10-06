/**
 * Exercises the git plumbing against real repositories with real conflicts.
 *
 * `src/git/stages.ts` deliberately does not import `vscode`, so this runs in
 * plain Node without downloading an editor. It mirrors the scratch-repo
 * approach of `tests/test_git_integration.py`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  GitError,
  listConflictedPaths,
  readConflictStages,
  stageResolved,
} from "../../git/stages";

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

after(() => {
  for (const repo of repos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" });
}

/**
 * Builds a repo where `path` was changed differently on two branches and a
 * merge has been attempted, leaving the conflict in the index.
 */
function conflictedRepo(
  path: string,
  base: string | null,
  ours: string,
  theirs: string,
): string {
  const repo = mkdtempSync(join(tmpdir(), "smr-"));
  repos.push(repo);
  git(repo, "init", "-q", "-b", "main");

  if (base === null) {
    // No common ancestor for the file: both branches add it independently.
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "seed");
  } else {
    writeFileSync(join(repo, path), base);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
  }

  git(repo, "checkout", "-qb", "feature");
  writeFileSync(join(repo, path), theirs);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "theirs");

  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, path), ours);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "ours");

  try {
    git(repo, "merge", "--no-edit", "feature");
    throw new Error("expected the merge to conflict");
  } catch (error) {
    if (error instanceof Error && error.message === "expected the merge to conflict") {
      throw error;
    }
    // A failed merge is the point: the conflict is now in the index.
  }
  return repo;
}

test("lists conflicted paths once each, not once per stage", async () => {
  const repo = conflictedRepo("config.json", '{"v":1}\n', '{"v":2}\n', '{"v":3}\n');
  assert.deepEqual(await listConflictedPaths(repo), ["config.json"]);
});

test("reads all three stages of a conflict", async () => {
  const repo = conflictedRepo("config.json", '{"v":1}\n', '{"v":2}\n', '{"v":3}\n');
  const stages = await readConflictStages(repo, "config.json");
  assert.equal(stages.base, '{"v":1}\n');
  assert.equal(stages.ours, '{"v":2}\n');
  assert.equal(stages.theirs, '{"v":3}\n');
});

test("reports a missing common ancestor as null rather than failing", async () => {
  const repo = conflictedRepo("added.json", null, '{"a":1}\n', '{"b":2}\n');
  const stages = await readConflictStages(repo, "added.json");
  assert.equal(stages.base, null);
  assert.equal(stages.ours, '{"a":1}\n');
  assert.equal(stages.theirs, '{"b":2}\n');
});

test("handles a path with spaces and non-ASCII characters", async () => {
  const name = "my cönfig file.json";
  const repo = conflictedRepo(name, '{"v":1}\n', '{"v":2}\n', '{"v":3}\n');
  assert.deepEqual(await listConflictedPaths(repo), [name]);
  assert.equal((await readConflictStages(repo, name)).ours, '{"v":2}\n');
});

test("refuses a modify/delete conflict with an explanation", async () => {
  const repo = mkdtempSync(join(tmpdir(), "smr-"));
  repos.push(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "gone.json"), '{"v":1}\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");

  git(repo, "checkout", "-qb", "feature");
  rmSync(join(repo, "gone.json"));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "deleted");

  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "gone.json"), '{"v":2}\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "modified");
  try {
    git(repo, "merge", "--no-edit", "feature");
  } catch {
    // expected
  }

  await assert.rejects(() => readConflictStages(repo, "gone.json"), GitError);
});

test("staging a path clears it from the conflict list", async () => {
  const repo = conflictedRepo("config.json", '{"v":1}\n', '{"v":2}\n', '{"v":3}\n');
  writeFileSync(join(repo, "config.json"), '{"v":4}\n');
  await stageResolved(repo, "config.json");
  assert.deepEqual(await listConflictedPaths(repo), []);
});

test("an empty repository has no conflicts and does not throw", async () => {
  const repo = mkdtempSync(join(tmpdir(), "smr-"));
  repos.push(repo);
  git(repo, "init", "-q", "-b", "main");
  assert.deepEqual(await listConflictedPaths(repo), []);
});

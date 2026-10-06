/**
 * Reading a conflict's three sides out of the git index.
 *
 * During a conflicted merge git keeps all three versions in the index as
 * numbered stages: 1 = common ancestor, 2 = ours, 3 = theirs. Reading them is
 * more reliable than parsing conflict markers out of the working-tree file,
 * and it is how the Python CLI receives its %O %A %B arguments.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Git cannot hold a blob bigger than this comfortably in a webview. */
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

export interface ConflictStages {
  /** null when the file has no common ancestor (both sides added it). */
  base: string | null;
  ours: string;
  theirs: string;
}

export class GitError extends Error {}

async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd: repoRoot,
      maxBuffer: MAX_BLOB_BYTES * 4,
      // Keep paths as raw bytes so non-ASCII filenames round-trip.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitError(message);
  }
}

/**
 * Paths with unmerged entries, relative to the repository root.
 *
 * `-z` plus `core.quotepath=false` keeps unusual filenames intact rather than
 * octal-escaped.
 */
export async function listConflictedPaths(repoRoot: string): Promise<string[]> {
  const stdout = await git(repoRoot, [
    "-c",
    "core.quotepath=false",
    "ls-files",
    "-u",
    "-z",
  ]);

  const paths = new Set<string>();
  for (const record of stdout.split("\0")) {
    if (record === "") {
      continue;
    }
    // Format: "<mode> <sha> <stage>\t<path>" — one record per stage, so the
    // same path appears up to three times.
    const tab = record.indexOf("\t");
    if (tab !== -1) {
      paths.add(record.slice(tab + 1));
    }
  }
  return [...paths].sort();
}

/** Reads one stage, or null when that stage does not exist. */
async function readStage(
  repoRoot: string,
  path: string,
  stage: 1 | 2 | 3,
): Promise<string | null> {
  try {
    return await git(repoRoot, ["show", `:${stage}:${path}`]);
  } catch {
    // A missing stage is normal: stage 1 is absent for an add/add conflict,
    // and stage 2 or 3 is absent when one side deleted the file.
    return null;
  }
}

export async function readConflictStages(
  repoRoot: string,
  path: string,
): Promise<ConflictStages> {
  const [base, ours, theirs] = await Promise.all([
    readStage(repoRoot, path, 1),
    readStage(repoRoot, path, 2),
    readStage(repoRoot, path, 3),
  ]);

  if (ours === null || theirs === null) {
    // A modify/delete conflict has no structure to merge: whether to keep the
    // file at all is the decision, which git's own tooling already presents.
    throw new GitError(
      `${path} was deleted on one side; resolve it as a whole file rather than key by key`,
    );
  }
  return { base, ours, theirs };
}

/** Stages the path, which is how git records a conflict as resolved. */
export async function stageResolved(repoRoot: string, path: string): Promise<void> {
  await git(repoRoot, ["add", "--", path]);
}

/** True while a merge, rebase, cherry-pick or revert is in progress. */
export async function hasUnmergedEntries(repoRoot: string): Promise<boolean> {
  const paths = await listConflictedPaths(repoRoot);
  return paths.length > 0;
}

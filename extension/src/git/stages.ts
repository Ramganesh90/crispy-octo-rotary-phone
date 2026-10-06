/**
 * Reading a conflict's three sides out of the git index.
 *
 * During a conflicted merge git keeps all three versions in the index as
 * numbered stages: 1 = common ancestor, 2 = ours, 3 = theirs. Reading them is
 * more reliable than parsing conflict markers out of the working-tree file,
 * and it is how the Python CLI receives its %O %A %B arguments.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * The conflicted content git itself writes for these three stages.
 *
 * Used to tell whether the working-tree file has been edited by hand since
 * the merge: if it differs from this, someone has been resolving it manually
 * and applying a structural result would throw that work away.
 */
async function conflictedText(
  repoRoot: string,
  stages: ConflictStages,
): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "smr-mergefile-"));
  try {
    const paths = {
      base: join(dir, "base"),
      ours: join(dir, "ours"),
      theirs: join(dir, "theirs"),
    };
    await Promise.all([
      writeFile(paths.base, stages.base ?? "", "utf8"),
      writeFile(paths.ours, stages.ours, "utf8"),
      writeFile(paths.theirs, stages.theirs, "utf8"),
    ]);

    // `git merge-file` exits with the number of conflicts, so a non-zero
    // status is the normal case and the output is what matters. A failure to
    // run at all also rejects, but with a non-numeric code (ENOENT) — and it
    // still carries an empty `stdout`, which must not be mistaken for a
    // genuinely empty merge result.
    const { stdout } = await exec(
      "git",
      ["merge-file", "-p", paths.ours, paths.base, paths.theirs],
      { cwd: repoRoot, maxBuffer: MAX_BLOB_BYTES * 4 },
    ).catch((error: { stdout?: unknown; code?: unknown }) =>
      typeof error.code === "number" &&
      error.code >= 0 &&
      typeof error.stdout === "string" &&
      error.stdout.length > 0
        ? { stdout: error.stdout }
        : { stdout: undefined },
    );
    return stdout;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Marker lines carry branch labels that differ between invocations, so
 * compare the content with the labels stripped.
 */
function normalizeMarkers(text: string): string {
  return text
    .replace(/^([<>|=]{7})[^\n]*$/gm, "$1")
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

/**
 * True when the file on disk is not what git left there — someone has edited
 * it since the merge stopped.
 */
export async function hasManualEdits(
  repoRoot: string,
  workingTreeText: string,
  stages: ConflictStages,
): Promise<boolean> {
  const expected = await conflictedText(repoRoot, stages);
  if (expected === undefined) {
    return false; // cannot tell; do not cry wolf
  }
  return normalizeMarkers(expected) !== normalizeMarkers(workingTreeText);
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

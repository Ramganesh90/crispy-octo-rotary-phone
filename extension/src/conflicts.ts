/**
 * The model behind the sidebar and the resolver: which files are conflicted,
 * what format each is, and how many structural decisions each needs.
 */

import * as vscode from "vscode";

import { findRepositories, type Repository } from "./git/repo";
import {
  type ConflictStages,
  listConflictedPaths,
  readConflictStages,
} from "./git/stages";
import { createEngine, detectFormat } from "./merge/index";
import {
  type MergeDocument,
  type MergeEngine,
  type MergeFormat,
  UnsupportedInput,
} from "./merge/types";

/** How a conflicted file can be handled. */
export type ConflictKind =
  /** Structural conflicts need decisions in the resolver. */
  | { kind: "structural"; conflictCount: number }
  /** The engine merges it with no decisions needed. */
  | { kind: "clean" }
  /** No engine for this format; git's text merge is the right tool. */
  | { kind: "text"; reason: string };

export interface ConflictFile {
  repo: Repository;
  /** Path relative to the repository root, as git reports it. */
  path: string;
  uri: vscode.Uri;
  format: MergeFormat | null;
  state: ConflictKind;
}

export interface AnalyzedConflict {
  file: ConflictFile;
  engine: MergeEngine;
  doc: MergeDocument;
}

/** Larger than this and the webview is the wrong tool. */
const MAX_ANALYZE_BYTES = 2 * 1024 * 1024;

export async function analyze(
  repo: Repository,
  path: string,
  format: MergeFormat,
): Promise<{ engine: MergeEngine; doc: MergeDocument; stages: ConflictStages }> {
  const stages = await readConflictStages(repo.root, path);
  const size = stages.ours.length + stages.theirs.length;
  if (size > MAX_ANALYZE_BYTES) {
    throw new UnsupportedInput(
      `file is too large to resolve structurally (${Math.round(size / 1024)} KB)`,
    );
  }
  const engine = createEngine(format);
  const doc = engine.analyze(stages.base, stages.ours, stages.theirs);
  return { engine, doc, stages };
}

async function classify(repo: Repository, path: string): Promise<ConflictFile> {
  const uri = vscode.Uri.joinPath(vscode.Uri.file(repo.root), ...path.split("/"));
  const format = detectFormat(path);

  if (format === null) {
    return {
      repo,
      path,
      uri,
      format,
      state: { kind: "text", reason: "not a structured format" },
    };
  }

  try {
    const { doc } = await analyze(repo, path, format);
    return {
      repo,
      path,
      uri,
      format,
      state:
        doc.conflictCount > 0
          ? { kind: "structural", conflictCount: doc.conflictCount }
          : { kind: "clean" },
    };
  } catch (error) {
    const reason =
      error instanceof UnsupportedInput || error instanceof Error
        ? error.message
        : String(error);
    return { repo, path, uri, format, state: { kind: "text", reason } };
  }
}

/** Every conflicted file across every repository, classified. */
export async function findConflicts(): Promise<ConflictFile[]> {
  const repos = await findRepositories();
  const results: ConflictFile[] = [];

  for (const repo of repos) {
    let paths: string[];
    try {
      paths = await listConflictedPaths(repo.root);
    } catch {
      continue; // not a usable repository right now
    }
    const classified = await Promise.all(paths.map((path) => classify(repo, path)));
    results.push(...classified);
  }
  return results;
}

/** Finds the conflict record for an open document, if it is one. */
export async function conflictForUri(
  uri: vscode.Uri,
): Promise<ConflictFile | undefined> {
  if (uri.scheme !== "file") {
    return undefined;
  }
  const conflicts = await findConflicts();
  return conflicts.find((c) => c.uri.fsPath === uri.fsPath);
}

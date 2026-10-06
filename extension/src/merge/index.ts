/** Format detection and the engine registry. */

import { createJsonEngine } from "./json";
import { createLinesEngine } from "./lines";
import type { MergeEngine, MergeFormat } from "./types";

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);

const LINE_SET_FILES = new Set([
  ".gitignore",
  ".dockerignore",
  ".npmignore",
  ".eslintignore",
  ".prettierignore",
  ".vscodeignore",
  "CODEOWNERS",
  ".nvmrc",
]);

/** Dotfiles that hold JSON despite having no .json extension. */
const JSON_DOTFILES = new Set([
  ".babelrc",
  ".eslintrc",
  ".prettierrc",
  ".swcrc",
  ".stylelintrc",
]);

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** The format for a path, or null when nothing structural applies. */
export function detectFormat(path: string): MergeFormat | null {
  const name = basename(path);
  const lower = name.toLowerCase();

  if (LOCKFILES.has(lower)) {
    return "lockfile";
  }
  if (LINE_SET_FILES.has(name) || LINE_SET_FILES.has(lower)) {
    return "lines";
  }
  if (JSON_DOTFILES.has(lower)) {
    return "json";
  }
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) {
    return "json";
  }
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return "yaml";
  }
  return null;
}

/** A fresh engine per document: engines keep per-document parse state. */
export function createEngine(format: MergeFormat): MergeEngine {
  switch (format) {
    case "json":
      return createJsonEngine();
    case "lines":
      return createLinesEngine();
    case "yaml":
    case "lockfile":
      // Added in a later phase; until then these fall back to a text merge.
      throw new Error(`No engine registered for format '${format}' yet`);
  }
}

export function createEngineForPath(path: string): MergeEngine | null {
  const format = detectFormat(path);
  if (format === null) {
    return null;
  }
  try {
    return createEngine(format);
  } catch {
    return null;
  }
}

export * from "./types";

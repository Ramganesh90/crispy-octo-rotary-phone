/** Format detection and the engine registry. */

import { createDotenvEngine } from "./dotenv";
import { createJsEngine } from "./js";
import { createJsonEngine } from "./json";
import { createLinesEngine } from "./lines";
import { createLockfileEngine } from "./lockfile";
import { createTomlEngine } from "./toml";
import type { MergeEngine, MergeFormat } from "./types";
import { createXmlEngine } from "./xml";
import { createYamlEngine } from "./yaml";

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
  if (lower.endsWith(".toml")) {
    return "toml";
  }
  if (
    lower.endsWith(".xml") ||
    lower.endsWith(".csproj") ||
    lower.endsWith(".props") ||
    lower.endsWith(".targets")
  ) {
    return "xml";
  }
  if (/\.(jsx?|mjs|cjs|tsx?|mts|cts)$/.test(lower)) {
    return "js";
  }
  // .env, .env.local, .env.production — but not .env.example's siblings being
  // treated differently, since they all have the same shape.
  if (name === ".env" || name.startsWith(".env.")) {
    return "dotenv";
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
      return createYamlEngine();
    case "lockfile":
      return createLockfileEngine();
    case "dotenv":
      return createDotenvEngine();
    case "toml":
      return createTomlEngine();
    case "xml":
      return createXmlEngine();
    case "js":
      return createJsEngine();
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

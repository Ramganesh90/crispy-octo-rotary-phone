/**
 * Three-way merge for TOML (`pyproject.toml`, `Cargo.toml`).
 *
 * TOML's value syntax is rich, and no widely used parser round-trips comments,
 * so rather than reprint the document this engine works on the *lines*: it
 * indexes `key = value` assignments by their table path, merges those keys,
 * and edits only the lines whose value changed. Everything it does not
 * understand it leaves exactly as written.
 *
 * That makes it good at the case that actually matters — two branches bumping
 * different dependencies, or the same one — and deliberately unambitious
 * elsewhere. Constructs whose meaning depends on structure it does not model
 * (arrays of tables, multi-line values) make the whole file fall back to a
 * text merge rather than risk writing something subtly wrong.
 */

import { annotateSuggestions } from "./suggest";
import { statusOf } from "./tree";
import {
  ABSENT,
  countConflicts,
  type MergeDocument,
  type MergeEngine,
  type MergeNode,
  resolvedValue,
  sameValue,
  type SideValue,
  sideValue,
  UnsupportedInput,
} from "./types";

/** `[table]` or `[table.sub]`. */
const TABLE = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/;
/** `[[array of tables]]` — not modelled, so the file falls back. */
const TABLE_ARRAY = /^\s*\[\[/;
/** `key = value`, with bare or quoted keys. */
const ASSIGNMENT = /^(\s*)((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))(\s*=\s*)(.*)$/;

interface Entry {
  /** Dotted path, e.g. `dependencies.serde`. */
  path: string;
  value: string;
  line: number;
}

function stripComment(value: string): string {
  // Only strips a comment outside quotes; good enough for scalar values and
  // inline tables, and anything ambiguous is left intact.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "#" && !inSingle && !inDouble) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquoteKey(key: string): string {
  return key.startsWith('"') || key.startsWith("'") ? key.slice(1, -1) : key;
}

function parse(text: string | null, label: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  if (!text) {
    return entries;
  }

  const lines = text.split(/\r?\n/);
  let table = "";

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    if (TABLE_ARRAY.test(line)) {
      throw new UnsupportedInput(
        `${label} uses an array of tables, whose entries this cannot match up safely`,
      );
    }

    const tableMatch = TABLE.exec(line);
    if (tableMatch) {
      table = tableMatch[1].trim();
      continue;
    }

    const assignment = ASSIGNMENT.exec(line);
    if (!assignment) {
      continue; // a continuation line or syntax not modelled; left alone
    }

    const value = stripComment(assignment[4]);
    // An unterminated bracket or quote means the value runs over several
    // lines, which this line-based model cannot safely rewrite.
    if (isMultiline(value)) {
      throw new UnsupportedInput(
        `${label} has a value spanning several lines, which this cannot edit safely`,
      );
    }

    const key = unquoteKey(assignment[2]);
    const path = table === "" ? key : `${table}.${key}`;
    entries.set(path, { path, value: value.trim(), line: index });
  }
  return entries;
}

function isMultiline(value: string): boolean {
  if (value.startsWith('"""') || value.startsWith("'''")) {
    return true;
  }
  const count = (text: string, char: string) =>
    [...text].filter((c) => c === char).length;
  return (
    count(value, "[") !== count(value, "]") ||
    count(value, "{") !== count(value, "}")
  );
}

function side(entries: Map<string, Entry>, path: string): SideValue {
  const entry = entries.get(path);
  return entry ? sideValue(true, entry.value) : ABSENT;
}

function orderedPaths(ours: Map<string, Entry>, theirs: Map<string, Entry>): string[] {
  const ourPaths = [...ours.keys()];
  const seen = new Set(ourPaths);
  return [...ourPaths, ...[...theirs.keys()].filter((p) => !seen.has(p))];
}

export class TomlMergeEngine implements MergeEngine {
  readonly format = "toml" as const;

  private oursText = "";
  private oursEntries = new Map<string, Entry>();

  analyze(base: string | null, ours: string, theirs: string): MergeDocument {
    const baseEntries = parse(base, "base");
    const oursEntries = parse(ours, "ours");
    const theirsEntries = parse(theirs, "theirs");

    this.oursText = ours;
    this.oursEntries = oursEntries;

    const root: MergeNode[] = orderedPaths(oursEntries, theirsEntries).map((path) => {
      const sides = {
        base: side(baseEntries, path),
        ours: side(oursEntries, path),
        theirs: side(theirsEntries, path),
      };
      const status = statusOf(sides.base, sides.ours, sides.theirs);
      return {
        id: `$[${JSON.stringify(path)}]`,
        label: path,
        path: [path],
        kind: "scalar" as const,
        status,
        sides,
        resolution:
          status === "conflict"
            ? ({ kind: "unresolved" } as const)
            : ({ kind: "auto" } as const),
      };
    });

    annotateSuggestions(root);
    return { format: "toml", root, ...countConflicts(root) };
  }

  serialize(doc: MergeDocument): string {
    const eol = this.oursText.includes("\r\n") ? "\r\n" : "\n";
    const lines = this.oursText.split(/\r?\n/);
    const removed = new Set<number>();
    /** New keys, grouped by the table they belong to. */
    const added = new Map<string, string[]>();

    for (const node of doc.root) {
      const resolved = resolvedValue(node);
      if (resolved === undefined || sameValue(resolved, node.sides.ours)) {
        continue;
      }
      const existing = this.oursEntries.get(node.label);

      if (!resolved.present) {
        if (existing) {
          removed.add(existing.line);
        }
        continue;
      }

      const value = String(resolved.value);
      if (existing) {
        // Replace only the value, keeping indentation, spacing around `=`,
        // and any trailing comment.
        lines[existing.line] = lines[existing.line].replace(
          ASSIGNMENT,
          (_whole, indent: string, key: string, equals: string, rest: string) => {
            const comment = rest.slice(stripComment(rest).length);
            return `${indent}${key}${equals}${value}${comment}`;
          },
        );
      } else {
        const dot = node.label.lastIndexOf(".");
        const table = dot === -1 ? "" : node.label.slice(0, dot);
        const key = dot === -1 ? node.label : node.label.slice(dot + 1);
        const list = added.get(table);
        if (list) {
          list.push(`${key} = ${value}`);
        } else {
          added.set(table, [`${key} = ${value}`]);
        }
      }
    }

    let result = lines.filter((_line, index) => !removed.has(index));

    for (const [table, assignments] of added) {
      result = insertIntoTable(result, table, assignments);
    }
    return result.join(eol);
  }
}

/** Puts new assignments at the end of their table, creating it if needed. */
function insertIntoTable(lines: string[], table: string, assignments: string[]): string[] {
  if (table === "") {
    // Top-level keys must come before the first table header.
    const firstTable = lines.findIndex((line) => TABLE.test(line));
    const at = firstTable === -1 ? lines.length : firstTable;
    return [...lines.slice(0, at), ...assignments, ...lines.slice(at)];
  }

  const header = lines.findIndex((line) => {
    const match = TABLE.exec(line);
    return match !== null && match[1].trim() === table;
  });

  if (header === -1) {
    const tail = lines.length > 0 && lines[lines.length - 1].trim() === "" ? [] : [""];
    return [...lines, ...tail, `[${table}]`, ...assignments, ""];
  }

  // The table runs until the next header.
  let end = header + 1;
  while (end < lines.length && !TABLE.test(lines[end])) {
    end++;
  }
  while (end > header + 1 && lines[end - 1].trim() === "") {
    end--; // keep blank lines between tables below the new keys
  }
  return [...lines.slice(0, end), ...assignments, ...lines.slice(end)];
}

export function createTomlEngine(): MergeEngine {
  return new TomlMergeEngine();
}

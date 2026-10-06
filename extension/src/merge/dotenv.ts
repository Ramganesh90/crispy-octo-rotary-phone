/**
 * Three-way merge for `.env` files.
 *
 * An env file is a list of `KEY=value` lines, so it merges key by key like an
 * object rather than line by line — two branches adding different variables
 * is not a conflict, and one branch changing a value the other left alone
 * applies cleanly.
 *
 * Serializing edits the current branch's text in place, so comments, blank
 * lines, grouping and quoting style all survive.
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
} from "./types";

/** `KEY=value`, optionally preceded by `export`, with surrounding spaces. */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/;

interface Entry {
  key: string;
  /** The value as written, quotes included. */
  raw: string;
  line: number;
}

function parse(text: string | null): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  if (!text) {
    return entries;
  }
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      return;
    }
    const match = ASSIGNMENT.exec(line);
    if (match) {
      // A repeated key means the last one wins at runtime, so track that one.
      entries.set(match[1], { key: match[1], raw: match[2].trim(), line: index });
    }
  });
  return entries;
}

function side(entries: Map<string, Entry>, key: string): SideValue {
  const entry = entries.get(key);
  return entry ? sideValue(true, entry.raw) : ABSENT;
}

/** Keys in ours' order, then keys only the incoming branch has. */
function orderedKeys(ours: Map<string, Entry>, theirs: Map<string, Entry>): string[] {
  const ourKeys = [...ours.keys()];
  const seen = new Set(ourKeys);
  return [...ourKeys, ...[...theirs.keys()].filter((k) => !seen.has(k))];
}

export class DotenvMergeEngine implements MergeEngine {
  readonly format = "dotenv" as const;

  private oursText = "";
  private oursEntries = new Map<string, Entry>();

  analyze(base: string | null, ours: string, theirs: string): MergeDocument {
    const baseEntries = parse(base);
    const oursEntries = parse(ours);
    const theirsEntries = parse(theirs);

    this.oursText = ours;
    this.oursEntries = oursEntries;

    const root: MergeNode[] = orderedKeys(oursEntries, theirsEntries).map((key) => {
      const sides = {
        base: side(baseEntries, key),
        ours: side(oursEntries, key),
        theirs: side(theirsEntries, key),
      };
      const status = statusOf(sides.base, sides.ours, sides.theirs);
      return {
        id: `$[${JSON.stringify(key)}]`,
        label: key,
        path: [key],
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
    return { format: "dotenv", root, ...countConflicts(root) };
  }

  serialize(doc: MergeDocument): string {
    const eol = this.oursText.includes("\r\n") ? "\r\n" : "\n";
    const lines = this.oursText.split(/\r?\n/);
    const removed = new Set<number>();
    const appended: string[] = [];

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
        // Rewrite just the value, keeping any `export` prefix and spacing.
        lines[existing.line] = lines[existing.line].replace(
          ASSIGNMENT,
          (_whole, key: string) =>
            lines[existing.line].slice(0, lines[existing.line].indexOf(key)) +
            `${key}=${value}`,
        );
      } else {
        appended.push(`${node.label}=${value}`);
      }
    }

    const kept = lines.filter((_line, index) => !removed.has(index));
    if (appended.length > 0) {
      // Keep the trailing blank line last if the file ended with one.
      while (kept.length > 0 && kept[kept.length - 1].trim() === "") {
        kept.pop();
      }
      kept.push(...appended, "");
    }
    return kept.join(eol);
  }
}

export function createDotenvEngine(): MergeEngine {
  return new DotenvMergeEngine();
}

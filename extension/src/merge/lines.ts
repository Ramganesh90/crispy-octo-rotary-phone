/**
 * Set-like merge for files that are unordered lists of lines
 * (.gitignore, CODEOWNERS, word lists).
 *
 * A port of `git_merge_driver/strategies/lines.py`: lines added on either
 * side are kept, lines removed on either side are dropped, order follows the
 * current branch with the incoming branch's additions appended. This never
 * conflicts, so the UI shows it as a reviewable add/remove checklist rather
 * than a set of decisions.
 */

import {
  ABSENT,
  countConflicts,
  type MergeDocument,
  type MergeEngine,
  type MergeNode,
  resolvedValue,
  type SideValue,
  sideValue,
} from "./types";

function splitLines(text: string | null): string[] {
  if (!text) {
    return [];
  }
  const lines = text.split(/\r\n|\n|\r/);
  // A trailing newline produces a final empty element that is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function statusForPresence(
  inBase: boolean,
  inOurs: boolean,
  inTheirs: boolean,
): MergeNode["status"] {
  if (inOurs === inTheirs) {
    return inBase === inOurs ? "unchanged" : "both-same";
  }
  return inBase === inOurs ? "theirs-only" : "ours-only";
}

export class LinesMergeEngine implements MergeEngine {
  readonly format = "lines" as const;

  private eol = "\n";
  private trailingNewline = true;

  analyze(base: string | null, ours: string, theirs: string): MergeDocument {
    const baseLines = new Set(splitLines(base));
    const oursLines = splitLines(ours);
    const theirsLines = splitLines(theirs);
    const oursSet = new Set(oursLines);
    const theirsSet = new Set(theirsLines);

    this.eol = ours.includes("\r\n") ? "\r\n" : "\n";
    this.trailingNewline = ours === "" || /\r?\n$/.test(ours);

    // Ours' order first, then lines only the incoming branch has.
    const candidates = [...oursLines, ...theirsLines.filter((l) => !oursSet.has(l))];
    const seen = new Set<string>();

    const root: MergeNode[] = [];
    for (const line of candidates) {
      if (seen.has(line)) {
        continue; // the Python engine is set-based, so duplicates collapse
      }
      seen.add(line);

      const inBase = baseLines.has(line);
      const inOurs = oursSet.has(line);
      const inTheirs = theirsSet.has(line);
      const present = (flag: boolean): SideValue => (flag ? sideValue(true, line) : ABSENT);

      root.push({
        id: `line:${line}`,
        label: line === "" ? "(blank line)" : line,
        path: [line],
        kind: "line",
        status: statusForPresence(inBase, inOurs, inTheirs),
        sides: { base: present(inBase), ours: present(inOurs), theirs: present(inTheirs) },
        resolution: { kind: "auto" },
      });
    }

    return { format: "lines", root, ...countConflicts(root) };
  }

  serialize(doc: MergeDocument): string {
    const kept: string[] = [];
    for (const node of doc.root) {
      const resolved = resolvedValue(node);
      if (resolved?.present) {
        kept.push(String(resolved.value));
      }
    }
    if (kept.length === 0) {
      return "";
    }
    return kept.join(this.eol) + (this.trailingNewline ? this.eol : "");
  }
}

export function createLinesEngine(): MergeEngine {
  return new LinesMergeEngine();
}

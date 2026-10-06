/**
 * Lockfiles (package-lock.json, npm-shrinkwrap.json).
 *
 * A lockfile is generated, and a hand-merged one is frequently wrong in ways
 * that only show up at install time: the dependency tree it describes has to
 * be internally consistent, which merging keys independently does not
 * guarantee. So this engine deliberately does *not* offer a key-by-key merge.
 * It presents the honest choice — take one side whole, then regenerate with
 * the package manager — and the host offers to run the regeneration.
 */

import {
  countConflicts,
  display,
  type MergeDocument,
  type MergeEngine,
  type MergeNode,
  resolvedValue,
  sideValue,
  UnsupportedInput,
} from "./types";

/** The node id the host looks for when offering regeneration. */
export const LOCKFILE_NODE_ID = "$";

function summarize(text: string, label: string): string {
  try {
    const parsed = JSON.parse(text) as { version?: string; packages?: object };
    const count = parsed.packages ? Object.keys(parsed.packages).length : undefined;
    return count === undefined
      ? `${label} version ${parsed.version ?? "?"}`
      : `${count} package${count === 1 ? "" : "s"}`;
  } catch {
    return display(text.slice(0, 40));
  }
}

export class LockfileMergeEngine implements MergeEngine {
  readonly format = "lockfile" as const;

  private ours = "";
  private theirs = "";
  private base: string | null = null;

  analyze(base: string | null, ours: string, theirs: string): MergeDocument {
    // Validate both sides so a corrupt lockfile falls back to a text merge
    // rather than being written back out unchecked.
    for (const [label, text] of [
      ["ours", ours],
      ["theirs", theirs],
    ] as const) {
      try {
        JSON.parse(text);
      } catch (error) {
        throw new UnsupportedInput(
          `${label} is not valid JSON: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    this.base = base;
    this.ours = ours;
    this.theirs = theirs;

    const node: MergeNode = {
      id: LOCKFILE_NODE_ID,
      label: "lockfile",
      path: [],
      kind: "scalar",
      status: "conflict",
      sides: {
        base:
          base === null
            ? { present: false, display: "—" }
            : { present: true, value: base, display: summarize(base, "base") },
        ours: { present: true, value: ours, display: summarize(ours, "ours") },
        theirs: { present: true, value: theirs, display: summarize(theirs, "theirs") },
      },
      resolution: { kind: "unresolved" },
    };

    const root = [node];
    return { format: "lockfile", root, ...countConflicts(root) };
  }

  serialize(doc: MergeDocument): string {
    const resolved = resolvedValue(doc.root[0]);
    if (resolved === undefined || !resolved.present) {
      return this.ours;
    }
    return String(resolved.value);
  }

  /** Exposed so the host can offer "keep theirs, then regenerate". */
  sideText(side: "base" | "ours" | "theirs"): string | null {
    return side === "ours" ? this.ours : side === "theirs" ? this.theirs : this.base;
  }
}

export function createLockfileEngine(): MergeEngine {
  return new LockfileMergeEngine();
}

/** The command that rebuilds a lockfile without touching node_modules. */
export function regenerateCommand(fileName: string): { command: string; args: string[] } {
  // Both npm lockfile names are regenerated the same way.
  void fileName;
  return { command: "npm", args: ["install", "--package-lock-only"] };
}

export { sideValue };

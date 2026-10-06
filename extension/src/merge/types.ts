/**
 * The data model shared by every merge engine and the webview UI.
 *
 * Engines in this directory must not import `vscode`: they are plain
 * TypeScript so they can be unit-tested in Node and compared against the
 * Python CLI in `git_merge_driver/`.
 */

export type Side = "base" | "ours" | "theirs";

export type MergeFormat = "json" | "yaml" | "lines" | "lockfile";

/**
 * How a node ended up with its value.
 *
 * `unchanged`   all three sides agree
 * `both-same`   both branches made the same change
 * `ours-only`   only the current branch changed it
 * `theirs-only` only the incoming branch changed it
 * `conflict`    both branches changed it differently — needs a decision
 */
export type NodeStatus =
  | "unchanged"
  | "both-same"
  | "ours-only"
  | "theirs-only"
  | "conflict";

export type Resolution =
  | { kind: "auto" }
  | { kind: "side"; side: Side }
  | { kind: "custom"; text: string }
  | { kind: "unresolved" };

/** One side's view of a node. `present: false` means deleted or never added. */
export interface SideValue {
  present: boolean;
  /** The parsed value. Absent when `present` is false. */
  value?: unknown;
  /** Short single-line rendering for the UI. */
  display: string;
}

export interface MergeNode {
  /** Stable identity used by the webview protocol, e.g. `$["deps"]["react"]`. */
  id: string;
  label: string;
  path: (string | number)[];
  kind: "object" | "array" | "scalar" | "line";
  status: NodeStatus;
  sides: { base: SideValue; ours: SideValue; theirs: SideValue };
  resolution: Resolution;
  children?: MergeNode[];
}

export interface MergeDocument {
  format: MergeFormat;
  root: MergeNode[];
  /** Number of nodes with status `conflict` anywhere in the tree. */
  conflictCount: number;
  /** Conflicts still awaiting a decision. */
  unresolvedCount: number;
  /** Set when the file could not be parsed structurally. */
  parseError?: string;
}

export interface MergeEngine {
  readonly format: MergeFormat;
  /** `base` is null when the file has no common ancestor (both sides added it). */
  analyze(base: string | null, ours: string, theirs: string): MergeDocument;
  /** Render the final file text for the choices recorded in `doc`. */
  serialize(doc: MergeDocument): string;
}

/** Thrown when a document cannot be parsed; callers fall back to a text merge. */
export class UnsupportedInput extends Error {}

export const ABSENT: SideValue = { present: false, display: "—" };

export function formatPath(path: (string | number)[]): string {
  if (path.length === 0) {
    return "$";
  }
  return "$" + path.map((p) => `[${JSON.stringify(p)}]`).join("");
}

/**
 * Canonical form used for equality, mirroring Python's
 * `json.dumps(value, sort_keys=True)` in `json_merge.py::_same`.
 *
 * Type tags keep `0`, `false` and `"0"` distinct, which `==` would not.
 * Note one accepted divergence from the Python engine: JavaScript parses
 * `1` and `1.0` to the same number, so this treats them as equal where
 * Python reports a conflict.
 */
export function canonical(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "a[" + value.map(canonical).join(",") + "]";
  }
  switch (typeof value) {
    case "object": {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
      return "o{" + entries.join(",") + "}";
    }
    case "string":
      return "s" + JSON.stringify(value);
    case "number":
      return "n" + String(value);
    case "boolean":
      return "b" + String(value);
    default:
      return "u";
  }
}

export function sameValue(a: SideValue, b: SideValue): boolean {
  if (!a.present || !b.present) {
    return a.present === b.present;
  }
  return canonical(a.value) === canonical(b.value);
}

/** Walk every node in a document, parents before children. */
export function* walk(nodes: MergeNode[]): Generator<MergeNode> {
  for (const node of nodes) {
    yield node;
    if (node.children) {
      yield* walk(node.children);
    }
  }
}

/**
 * Counts only leaf nodes: a container is marked `conflict` when a descendant
 * conflicts, so counting containers too would report each conflict twice.
 */
export function countConflicts(root: MergeNode[]): {
  conflictCount: number;
  unresolvedCount: number;
} {
  let conflictCount = 0;
  let unresolvedCount = 0;
  for (const node of walk(root)) {
    if (!node.children && node.status === "conflict") {
      conflictCount++;
      if (node.resolution.kind === "unresolved") {
        unresolvedCount++;
      }
    }
  }
  return { conflictCount, unresolvedCount };
}

/**
 * The value a node resolves to, or `undefined` when the node resolves to
 * "not present" (a deletion) or is still unresolved.
 */
export function resolvedValue(node: MergeNode): SideValue | undefined {
  switch (node.resolution.kind) {
    case "unresolved":
      return undefined;
    case "side":
      return node.sides[node.resolution.side];
    case "custom": {
      const text = node.resolution.text;
      let value: unknown = text;
      try {
        value = JSON.parse(text);
      } catch {
        // Not valid JSON: treat the typed text as a plain string.
      }
      return { present: true, value, display: text };
    }
    case "auto":
      switch (node.status) {
        case "theirs-only":
          return node.sides.theirs;
        case "unchanged":
        case "both-same":
        case "ours-only":
          return node.sides.ours;
        case "conflict":
          // An auto-resolved conflict keeps ours, matching the CLI's behavior
          // of preferring the current branch on a conflicting path.
          return node.sides.ours;
      }
  }
}

export function display(value: unknown, maxLength = 80): string {
  let text: string;
  if (Array.isArray(value)) {
    text = `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  } else if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as object);
    text = `{${keys.length} key${keys.length === 1 ? "" : "s"}}`;
  } else {
    text = JSON.stringify(value) ?? String(value);
  }
  return text.length > maxLength ? text.slice(0, maxLength - 1) + "…" : text;
}

export function sideValue(present: boolean, value?: unknown): SideValue {
  return present ? { present: true, value, display: display(value) } : ABSENT;
}

/**
 * Building the decision tree from three parsed documents.
 *
 * Shared by the JSON and YAML engines: both reduce their document to plain
 * JavaScript values, differing only in how they parse and re-serialize. The
 * semantics are a port of `git_merge_driver/strategies/json_merge.py`.
 */

import {
  ABSENT,
  formatPath,
  type MergeNode,
  type NodeStatus,
  resolvedValue,
  sameValue,
  type SideValue,
  sideValue,
} from "./types";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function statusOf(
  base: SideValue,
  ours: SideValue,
  theirs: SideValue,
): NodeStatus {
  if (sameValue(ours, theirs)) {
    return sameValue(base, ours) ? "unchanged" : "both-same";
  }
  if (sameValue(base, ours)) {
    return "theirs-only";
  }
  if (sameValue(base, theirs)) {
    return "ours-only";
  }
  return "conflict";
}

function childOf(value: SideValue, key: string): SideValue {
  if (!value.present || !isPlainObject(value.value)) {
    return ABSENT;
  }
  if (!Object.prototype.hasOwnProperty.call(value.value, key)) {
    return ABSENT;
  }
  return sideValue(true, value.value[key]);
}

/** Keys in ours' order, then keys only theirs has. */
function mergedKeys(ours: SideValue, theirs: SideValue): string[] {
  const ourKeys = ours.present && isPlainObject(ours.value) ? Object.keys(ours.value) : [];
  const theirKeys =
    theirs.present && isPlainObject(theirs.value) ? Object.keys(theirs.value) : [];
  const seen = new Set(ourKeys);
  return [...ourKeys, ...theirKeys.filter((k) => !seen.has(k))];
}

export function buildNode(
  base: SideValue,
  ours: SideValue,
  theirs: SideValue,
  path: (string | number)[] = [],
  label = "$",
): MergeNode {
  const status = statusOf(base, ours, theirs);
  const node: MergeNode = {
    id: formatPath(path),
    label,
    path,
    kind: "scalar",
    status,
    sides: { base, ours, theirs },
    resolution: { kind: "auto" },
  };

  // Recurse only where both sides still hold a mapping and they differ: that
  // is the case a line-based merge handles badly and this handles well.
  const bothObjects =
    ours.present && theirs.present && isPlainObject(ours.value) && isPlainObject(theirs.value);

  if (bothObjects && status !== "unchanged") {
    const baseForChildren = base.present && isPlainObject(base.value) ? base : ABSENT;
    node.kind = "object";
    node.children = mergedKeys(ours, theirs).map((key) =>
      buildNode(
        childOf(baseForChildren, key),
        childOf(ours, key),
        childOf(theirs, key),
        [...path, key],
        key,
      ),
    );
    // A container's own status only summarises its children once we recurse.
    node.status = node.children.some((c) => c.status === "conflict")
      ? "conflict"
      : node.children.every((c) => c.status === "unchanged")
        ? "unchanged"
        : "both-same";
    return node;
  }

  if (isPlainObject(ours.value) || isPlainObject(theirs.value)) {
    node.kind = "object";
  } else if (Array.isArray(ours.value) || Array.isArray(theirs.value)) {
    node.kind = "array";
  }
  if (status === "conflict") {
    node.resolution = { kind: "unresolved" };
  }
  return node;
}

export interface LeafEdit {
  path: (string | number)[];
  /** `undefined` means remove the key. */
  value: unknown;
  present: boolean;
}

/**
 * The leaf decisions that differ from what the ours text already says.
 * Unresolved conflicts are skipped, leaving the current branch's value — the
 * same thing the CLI does when it reports a conflicting path.
 */
export function collectLeafEdits(nodes: MergeNode[], edits: LeafEdit[] = []): LeafEdit[] {
  for (const node of nodes) {
    if (node.children) {
      collectLeafEdits(node.children, edits);
      continue;
    }
    const resolved = resolvedValue(node);
    if (resolved === undefined || sameValue(resolved, node.sides.ours)) {
      continue;
    }
    edits.push({
      path: node.path,
      value: resolved.present ? resolved.value : undefined,
      present: resolved.present,
    });
  }
  return edits;
}

/**
 * Building the decision tree from three parsed documents.
 *
 * Shared by the JSON and YAML engines: both reduce their document to plain
 * JavaScript values, differing only in how they parse and re-serialize. The
 * semantics are a port of `git_merge_driver/strategies/json_merge.py`.
 */

import {
  type ArrayStrategy,
  arrayStrategy,
  describeStrategy,
  elementIdentity,
  elementLabel,
} from "./arrays";
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

  // Both sides are arrays and they differ: merge the entries where the array's
  // shape makes that safe, rather than forcing an all-or-nothing choice.
  if (
    ours.present &&
    theirs.present &&
    Array.isArray(ours.value) &&
    Array.isArray(theirs.value) &&
    status !== "unchanged"
  ) {
    node.kind = "array";
    const baseItems = Array.isArray(base.value) ? base.value : [];
    const strategy = arrayStrategy([baseItems, ours.value, theirs.value]);
    node.arrayStrategy = describeStrategy(strategy);

    if (strategy.kind !== "atomic") {
      node.children = buildArrayChildren(
        strategy,
        baseItems,
        ours.value,
        theirs.value,
        path,
      );
      node.status = node.children.some((c) => c.status === "conflict")
        ? "conflict"
        : "both-same";
      return node;
    }
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

/**
 * One child per distinct element, in ours' order with the incoming branch's
 * new entries appended — the same ordering rule the object and line-set
 * merges use.
 *
 * Note these children's `path` segments are element identities, not JSON
 * pointers: an array is serialized as one whole value (see `materialize`),
 * because set and keyed merges shift indices.
 */
function buildArrayChildren(
  strategy: ArrayStrategy,
  baseItems: unknown[],
  ourItems: unknown[],
  theirItems: unknown[],
  path: (string | number)[],
): MergeNode[] {
  const index = (items: unknown[]) =>
    new Map(items.map((item) => [elementIdentity(item, strategy), item]));

  const baseIndex = index(baseItems);
  const oursIndex = index(ourItems);
  const theirsIndex = index(theirItems);

  const order = [
    ...ourItems.map((i) => elementIdentity(i, strategy)),
    ...theirItems
      .map((i) => elementIdentity(i, strategy))
      .filter((id) => !oursIndex.has(id)),
  ];

  return order.map((id) => {
    const at = (map: Map<string, unknown>): SideValue =>
      map.has(id) ? sideValue(true, map.get(id)) : ABSENT;

    const item = oursIndex.get(id) ?? theirsIndex.get(id);
    return buildNode(
      at(baseIndex),
      at(oursIndex),
      at(theirsIndex),
      [...path, id],
      elementLabel(item, strategy),
    );
  });
}

/**
 * The value a node resolves to, folding in every descendant's decision.
 * Returns undefined when anything below it is still unresolved.
 *
 * An explicit choice on a container wins over its children, which is what
 * makes "keep this whole array as ours" work.
 */
export function materialize(node: MergeNode): SideValue | undefined {
  if (node.resolution.kind === "side" || node.resolution.kind === "custom") {
    return resolvedValue(node);
  }
  if (!node.children) {
    return resolvedValue(node);
  }

  if (node.kind === "array") {
    const items: unknown[] = [];
    for (const child of node.children) {
      const value = materialize(child);
      if (value === undefined) {
        return undefined;
      }
      if (value.present) {
        items.push(value.value);
      }
    }
    return sideValue(true, items);
  }

  const merged: Record<string, unknown> = {};
  for (const child of node.children) {
    const value = materialize(child);
    if (value === undefined) {
      return undefined;
    }
    if (value.present) {
      merged[child.label] = value.value;
    }
  }
  return sideValue(true, merged);
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
    // A merged array is written as one value: its children are matched by
    // identity, so per-index edits would land on the wrong entries.
    if (node.children && node.kind === "array") {
      const resolved = materialize(node);
      if (resolved !== undefined && !sameValue(resolved, node.sides.ours)) {
        edits.push({
          path: node.path,
          value: resolved.present ? resolved.value : undefined,
          present: resolved.present,
        });
      }
      continue;
    }
    if (node.children) {
      // An explicit choice on an object container overrides its children.
      if (node.resolution.kind === "side" || node.resolution.kind === "custom") {
        const resolved = materialize(node);
        if (resolved !== undefined && !sameValue(resolved, node.sides.ours)) {
          edits.push({
            path: node.path,
            value: resolved.present ? resolved.value : undefined,
            present: resolved.present,
          });
        }
        continue;
      }
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

/**
 * Structural three-way merge for JSON and JSONC.
 *
 * Semantics are a port of `git_merge_driver/strategies/json_merge.py`:
 * objects merge key by key recursively, everything else (scalars, arrays) is
 * atomic, and a path both sides changed differently is a conflict.
 *
 * Unlike the Python engine, the result is produced by applying edits to the
 * *ours* text with `jsonc-parser`, so comments, trailing commas and the
 * original formatting of untouched regions survive the merge.
 */

import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";

import {
  ABSENT,
  countConflicts,
  formatPath,
  type MergeDocument,
  type MergeEngine,
  type MergeNode,
  type NodeStatus,
  resolvedValue,
  sameValue,
  type SideValue,
  sideValue,
  UnsupportedInput,
} from "./types";

function parseSide(text: string | null, label: string): SideValue {
  if (text === null || text.trim() === "") {
    return ABSENT;
  }
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const { error, offset } = errors[0];
    throw new UnsupportedInput(
      `${label} is not valid JSON (error code ${error} at offset ${offset})`,
    );
  }
  return sideValue(true, value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statusOf(base: SideValue, ours: SideValue, theirs: SideValue): NodeStatus {
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

/** Keys in ours' order, then keys only theirs has, matching the Python port. */
function mergedKeys(ours: SideValue, theirs: SideValue): string[] {
  const ourKeys = ours.present && isPlainObject(ours.value) ? Object.keys(ours.value) : [];
  const theirKeys =
    theirs.present && isPlainObject(theirs.value) ? Object.keys(theirs.value) : [];
  const seen = new Set(ourKeys);
  return [...ourKeys, ...theirKeys.filter((k) => !seen.has(k))];
}

function buildNode(
  base: SideValue,
  ours: SideValue,
  theirs: SideValue,
  path: (string | number)[],
  label: string,
): MergeNode {
  const status = statusOf(base, ours, theirs);
  const node: MergeNode = {
    id: formatPath(path),
    label,
    path,
    kind: isPlainObject(ours.value) || isPlainObject(theirs.value) ? "object" : "scalar",
    status,
    sides: { base, ours, theirs },
    resolution: { kind: "auto" },
  };

  // Recurse only where both sides still hold an object and they differ:
  // that is the case line-based merges handle badly and we handle well.
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
    // A container is only as conflicted as its children; its own status is
    // informational once we have recursed into it.
    node.status = node.children.some((c) => c.status === "conflict")
      ? "conflict"
      : node.children.every((c) => c.status === "unchanged")
        ? "unchanged"
        : "both-same";
    node.resolution = { kind: "auto" };
    return node;
  }

  if (Array.isArray(ours.value) || Array.isArray(theirs.value)) {
    node.kind = "array";
  }
  if (status === "conflict") {
    node.resolution = { kind: "unresolved" };
  }
  return node;
}

/**
 * Collect the leaf decisions that differ from the ours text, as
 * `jsonc-parser` edits. A node resolving to "not present" becomes a removal.
 */
function collectEdits(
  nodes: MergeNode[],
  oursRoot: SideValue,
  edits: { path: (string | number)[]; value: unknown }[],
): void {
  for (const node of nodes) {
    if (node.children) {
      collectEdits(node.children, oursRoot, edits);
      continue;
    }
    const resolved = resolvedValue(node);
    if (resolved === undefined) {
      continue; // unresolved: the caller refuses to serialize
    }
    const ours = node.sides.ours;
    if (sameValue(resolved, ours)) {
      continue; // already what the ours text says
    }
    edits.push({
      path: node.path,
      value: resolved.present ? resolved.value : undefined,
    });
  }
}

function detectIndent(text: string): { insertSpaces: boolean; tabSize: number } {
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) {
    return { insertSpaces: true, tabSize: 2 };
  }
  const indent = match[1];
  return indent.includes("\t")
    ? { insertSpaces: false, tabSize: 1 }
    : { insertSpaces: true, tabSize: indent.length };
}

export class JsonMergeEngine implements MergeEngine {
  readonly format = "json" as const;

  /** Kept so `serialize` can edit the original text rather than reprint it. */
  private oursText = "";

  analyze(base: string | null, ours: string, theirs: string): MergeDocument {
    const baseValue = parseSide(base, "base");
    const oursValue = parseSide(ours, "ours");
    const theirsValue = parseSide(theirs, "theirs");
    this.oursText = ours;

    const rootNode = buildNode(baseValue, oursValue, theirsValue, [], "$");
    const root = rootNode.children ?? [rootNode];
    const counts = countConflicts(root);
    return { format: "json", root, ...counts };
  }

  serialize(doc: MergeDocument): string {
    const edits: { path: (string | number)[]; value: unknown }[] = [];
    collectEdits(doc.root, sideValue(true, parseJsonc(this.oursText) as unknown), edits);

    const formattingOptions = {
      ...detectIndent(this.oursText),
      eol: this.oursText.includes("\r\n") ? "\r\n" : "\n",
    };

    let text = this.oursText;
    for (const edit of edits) {
      text = applyEdits(text, modify(text, edit.path, edit.value, { formattingOptions }));
    }
    return text;
  }
}

export function createJsonEngine(): MergeEngine {
  return new JsonMergeEngine();
}

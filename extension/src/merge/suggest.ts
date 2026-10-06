/**
 * Marking the side the engine believes is right.
 *
 * The overwhelmingly common structured conflict is two branches bumping the
 * same dependency, where the answer is nearly always the newer version. A
 * suggestion is only ever a hint: it is shown as "Recommended", it never
 * applies itself, and Apply stays blocked until a human chooses.
 */

import type { MergeNode, Side } from "./types";
import { walk } from "./types";

/** A version with an optional range operator, e.g. `^18.2.0`, `>=20`, `~5.0`. */
const VERSION = /^\s*([~^]|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?\s*$/;

interface Version {
  operator: string;
  parts: [number, number, number];
  prerelease?: string;
}

export function parseVersion(text: unknown): Version | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  const match = VERSION.exec(text);
  if (!match) {
    return undefined;
  }
  return {
    operator: match[1] ?? "",
    parts: [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)],
    prerelease: match[5],
  };
}

/** Negative when a is older, positive when newer, 0 when equal. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) {
      return a.parts[i] - b.parts[i];
    }
  }
  // A prerelease sorts below the release it leads to: 1.0.0-rc < 1.0.0.
  if (a.prerelease && !b.prerelease) {
    return -1;
  }
  if (!a.prerelease && b.prerelease) {
    return 1;
  }
  if (a.prerelease && b.prerelease) {
    return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
  }
  return 0;
}

function format(version: Version): string {
  return version.parts.join(".");
}

/**
 * A suggestion for one node, or undefined when nothing can be said.
 *
 * Deliberately narrow: it fires only when both sides are recognisable
 * versions and they differ. Anything else is a judgement call this code has
 * no business making.
 */
export function suggestFor(node: MergeNode): MergeNode["suggestion"] {
  if (node.status !== "conflict" || node.children) {
    return undefined;
  }
  const ours = parseVersion(node.sides.ours.value);
  const theirs = parseVersion(node.sides.theirs.value);
  if (!ours || !theirs) {
    return undefined;
  }

  const order = compareVersions(ours, theirs);
  if (order === 0) {
    return undefined;
  }

  const newer: Side = order > 0 ? "ours" : "theirs";
  const newerVersion = order > 0 ? ours : theirs;
  const olderVersion = order > 0 ? theirs : ours;

  const major = newerVersion.parts[0] !== olderVersion.parts[0];
  const reason = major
    ? `newer, but ${format(olderVersion)} → ${format(newerVersion)} is a major bump`
    : `newer (${format(olderVersion)} → ${format(newerVersion)})`;

  return { side: newer, reason };
}

/** Annotates every node in a document in place. Returns how many were marked. */
export function annotateSuggestions(root: MergeNode[]): number {
  let count = 0;
  for (const node of walk(root)) {
    const suggestion = suggestFor(node);
    if (suggestion) {
      node.suggestion = suggestion;
      count++;
    }
  }
  return count;
}

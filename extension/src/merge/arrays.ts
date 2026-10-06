/**
 * Choosing how to merge an array.
 *
 * Arrays in config files are usually one of two things wearing the same
 * syntax: an unordered *set* (`tsconfig.include`, `package.json.files`,
 * `eslint.extends`) or a list of *records* with an identity
 * (`steps` keyed by `uses`, `eslint.overrides` keyed by `files`). Both can be
 * merged far better than all-or-nothing. Anything else stays atomic, because
 * guessing wrong about an array silently changes what the file means.
 */

import { canonical } from "./types";

/** Fields treated as an element's identity, in order of preference. */
const IDENTITY_KEYS = ["id", "name", "key", "uses", "path", "files", "url"];

export type ArrayStrategy =
  | { kind: "set" }
  | { kind: "keyed"; key: string }
  | { kind: "atomic"; reason: string };

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasDuplicates(items: unknown[]): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    const key = canonical(item);
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

/**
 * A key usable as identity across every side: present on every element, a
 * scalar, and unique within each array.
 */
function identityKey(sides: unknown[][]): string | undefined {
  return IDENTITY_KEYS.find((key) =>
    sides.every((items) => {
      const values = items.map((item) => (isRecord(item) ? item[key] : undefined));
      if (values.some((value) => value === undefined || !isScalar(value))) {
        return false;
      }
      return new Set(values.map((v) => canonical(v))).size === values.length;
    }),
  );
}

/**
 * Decides how to merge, given every side that is present. Returning `atomic`
 * is always safe, so every uncertain case returns it with a reason the UI can
 * show.
 */
export function arrayStrategy(sides: unknown[][]): ArrayStrategy {
  const all = sides.flat();

  if (all.length === 0) {
    return { kind: "set" };
  }
  // A duplicate would be silently collapsed by a set merge, changing meaning.
  if (sides.some(hasDuplicates)) {
    return { kind: "atomic", reason: "contains repeated entries" };
  }

  if (all.every(isScalar)) {
    return { kind: "set" };
  }

  if (all.every(isRecord)) {
    const key = identityKey(sides);
    return key
      ? { kind: "keyed", key }
      : { kind: "atomic", reason: "entries have no field identifying them" };
  }

  return { kind: "atomic", reason: "entries are of mixed kinds" };
}

export function describeStrategy(strategy: ArrayStrategy): string {
  switch (strategy.kind) {
    case "set":
      return "merged as a list";
    case "keyed":
      return `matched up by \`${strategy.key}\``;
    case "atomic":
      return `kept whole — ${strategy.reason}`;
  }
}

/** The identity of one element under a strategy, used to match across sides. */
export function elementIdentity(item: unknown, strategy: ArrayStrategy): string {
  if (strategy.kind === "keyed" && isRecord(item)) {
    return String(item[strategy.key]);
  }
  return canonical(item);
}

/** A short human label for an element. */
export function elementLabel(item: unknown, strategy: ArrayStrategy): string {
  if (strategy.kind === "keyed" && isRecord(item)) {
    return String(item[strategy.key]);
  }
  if (isScalar(item)) {
    return typeof item === "string" ? item : JSON.stringify(item);
  }
  return canonical(item).slice(0, 40);
}

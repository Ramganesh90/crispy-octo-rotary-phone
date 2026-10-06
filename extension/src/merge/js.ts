/**
 * Three-way merge for JavaScript, JSX and TypeScript.
 *
 * Source code does not decompose into named values the way JSON does, so this
 * engine works at two levels at once:
 *
 *  1. **Top-level declarations** — imports, functions, classes, constants,
 *     exports and type declarations — are matched by name across the three
 *     sides. Each branch adding a function, or editing a different one, merges
 *     with nothing to decide.
 *
 *  2. **Inside a declaration both branches touched**, a line-level three-way
 *     merge runs over just that declaration. Two people editing different
 *     parts of the same function still merge cleanly.
 *
 * The second level matters more than it looks: without it, declaration-level
 * matching would report a conflict for every shared function, making this
 * *worse* than git's line merge for the most common case in real code. Only
 * when the line merge inside a declaration genuinely conflicts does a decision
 * reach the user — and then the unit is the whole declaration, which is at
 * least a thing a person can reason about.
 *
 * Nothing is ever reprinted: the output is the current branch's text with
 * individual declaration spans spliced, so formatting, comments and
 * everything untouched survive exactly.
 */

import { parse } from "@babel/parser";
import { mergeDigIn } from "node-diff3";

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
  UnsupportedInput,
} from "./types";

/** A top-level declaration, with the exact source range it occupies. */
interface Unit {
  key: string;
  label: string;
  text: string;
  start: number;
  end: number;
  isImport: boolean;
}

interface Parsed {
  units: Map<string, Unit>;
  /** Declaration order, used to place additions sensibly. */
  order: string[];
  text: string;
}

type Node = {
  type: string;
  start: number;
  end: number;
  leadingComments?: { start: number; end: number }[];
  [key: string]: unknown;
};

function nameOf(node: Node): string | undefined {
  const id = node.id as { name?: string } | undefined;
  if (id?.name) {
    return id.name;
  }
  if (node.type === "VariableDeclaration") {
    const names = (node.declarations as { id?: { name?: string } }[])
      .map((d) => d.id?.name)
      .filter((n): n is string => typeof n === "string");
    return names.length > 0 ? names.join(", ") : undefined;
  }
  return undefined;
}

/**
 * A stable identity for a top-level statement.
 *
 * Named declarations key by name, so moving one does not read as a delete and
 * an add. Anonymous statements key by their position among statements of the
 * same type, which is the best available and good enough: a changed one reads
 * as changed rather than as a replacement.
 */
function keyOf(node: Node, anonymous: Map<string, number>): { key: string; label: string } {
  const source = (node.source as { value?: string } | undefined)?.value;

  switch (node.type) {
    case "ImportDeclaration":
      return { key: `import:${source}`, label: `import … from "${source}"` };
    case "ExportAllDeclaration":
      return { key: `export-all:${source}`, label: `export * from "${source}"` };
    case "ExportDefaultDeclaration":
      return { key: "export:default", label: "export default" };
    case "ExportNamedDeclaration": {
      const inner = node.declaration as Node | null;
      if (inner) {
        const name = nameOf(inner);
        if (name) {
          return { key: `decl:${name}`, label: `export ${name}` };
        }
      }
      if (source) {
        return { key: `export-from:${source}`, label: `export … from "${source}"` };
      }
      break;
    }
    default: {
      const name = nameOf(node);
      if (name) {
        return { key: `decl:${name}`, label: name };
      }
    }
  }

  const seen = (anonymous.get(node.type) ?? 0) + 1;
  anonymous.set(node.type, seen);
  return { key: `${node.type}#${seen}`, label: `${node.type} #${seen}` };
}

/**
 * Where a declaration really starts: its own leading comments belong to it, so
 * a JSDoc block travels with the function it documents. A comment is only
 * claimed when nothing but whitespace separates it from the declaration and it
 * sits after the previous declaration.
 */
function startIncludingComments(node: Node, text: string, previousEnd: number): number {
  let start = node.start;
  for (const comment of node.leadingComments ?? []) {
    if (comment.start < previousEnd) {
      continue; // belongs to whatever came before
    }
    if (text.slice(comment.end, start).trim() === "") {
      start = Math.min(start, comment.start);
    }
  }
  return start;
}

function parseSide(text: string | null, label: string): Parsed {
  if (text === null || text.trim() === "") {
    return { units: new Map(), order: [], text: text ?? "" };
  }

  let body: Node[];
  try {
    const ast = parse(text, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      errorRecovery: false,
      plugins: ["jsx", "typescript", "decoratorAutoAccessors", "explicitResourceManagement"],
    });
    body = ast.program.body as unknown as Node[];
  } catch (error) {
    throw new UnsupportedInput(
      `${label} could not be parsed: ${error instanceof Error ? error.message : error}`,
    );
  }

  const units = new Map<string, Unit>();
  const order: string[] = [];
  const anonymous = new Map<string, number>();
  let previousEnd = 0;

  for (const node of body) {
    const { key, label: nodeLabel } = keyOf(node, anonymous);
    // A repeated key (two imports from one module) keeps both, numbered.
    let unique = key;
    for (let n = 2; units.has(unique); n++) {
      unique = `${key}~${n}`;
    }

    const start = startIncludingComments(node, text, previousEnd);
    units.set(unique, {
      key: unique,
      label: nodeLabel,
      text: text.slice(start, node.end),
      start,
      end: node.end,
      isImport: node.type === "ImportDeclaration",
    });
    order.push(unique);
    previousEnd = node.end;
  }

  return { units, order, text };
}

/**
 * A declaration's one-line summary for the tree: its signature, not a
 * JSON-escaped dump of the whole body.
 */
function summarize(text: string): string {
  const lines = text.split("\n");
  const first = lines.find((line) => line.trim() !== "" && !line.trim().startsWith("*")) ?? "";
  const trimmed = first.trim();
  const head = trimmed.length > 72 ? `${trimmed.slice(0, 71)}…` : trimmed;
  return lines.length > 1 ? `${head} …` : head;
}

function side(parsed: Parsed, key: string): SideValue {
  const unit = parsed.units.get(key);
  if (!unit) {
    return ABSENT;
  }
  return { present: true, value: unit.text, display: summarize(unit.text) };
}

/**
 * A line-level three-way merge of one declaration. Returns the merged text
 * when the two branches' edits do not overlap, and undefined when they do.
 */
function mergeWithin(
  base: string | undefined,
  ours: string,
  theirs: string,
): string | undefined {
  if (base === undefined) {
    return undefined; // no ancestor to merge against
  }
  const result = mergeDigIn(ours.split("\n"), base.split("\n"), theirs.split("\n"));
  return result.conflict ? undefined : result.result.join("\n");
}

export class JsMergeEngine implements MergeEngine {
  readonly format = "js" as const;

  private ours: Parsed = { units: new Map(), order: [], text: "" };
  private theirs: Parsed = { units: new Map(), order: [], text: "" };

  analyze(base: string | null, ours: string, theirs: string): MergeDocument {
    const baseParsed = parseSide(base, "base");
    this.ours = parseSide(ours, "ours");
    this.theirs = parseSide(theirs, "theirs");

    const seen = new Set(this.ours.order);
    const keys = [...this.ours.order, ...this.theirs.order.filter((k) => !seen.has(k))];

    const root: MergeNode[] = keys.map((key) => {
      const sides = {
        base: side(baseParsed, key),
        ours: side(this.ours, key),
        theirs: side(this.theirs, key),
      };
      let status = statusOf(sides.base, sides.ours, sides.theirs);
      const node: MergeNode = {
        id: `$[${JSON.stringify(key)}]`,
        label: this.ours.units.get(key)?.label ?? this.theirs.units.get(key)?.label ?? key,
        path: [key],
        kind: "scalar",
        status,
        sides,
        resolution: { kind: "auto" },
      };

      if (status === "conflict") {
        // Both branches changed this declaration. Try a line merge inside it
        // before asking anyone to choose: edits to different parts of the same
        // function are exactly what git handles well, and this must not be
        // worse than git.
        const merged = mergeWithin(
          sides.base.present ? String(sides.base.value) : undefined,
          String(sides.ours.value),
          String(sides.theirs.value),
        );
        if (merged !== undefined) {
          node.resolution = { kind: "custom", text: merged };
          node.arrayStrategy = "both edited; merged line by line inside";
          status = "both-same";
          node.status = status;
        } else {
          node.resolution = { kind: "unresolved" };
          node.arrayStrategy = "both edited the same lines";
        }
      }
      return node;
    });

    return { format: "js", root, ...countConflicts(root) };
  }

  serialize(doc: MergeDocument): string {
    interface Splice {
      start: number;
      end: number;
      text: string;
    }
    const splices: Splice[] = [];

    for (const node of doc.root) {
      const key = String(node.path[0]);
      const resolved = resolvedValue(node);
      if (resolved === undefined || sameValue(resolved, node.sides.ours)) {
        continue;
      }
      const existing = this.ours.units.get(key);

      if (!resolved.present) {
        if (existing) {
          // Take the following blank line with it, so removing a declaration
          // does not leave a growing gap behind.
          const after = /^[ \t]*\r?\n/.exec(this.ours.text.slice(existing.end));
          splices.push({
            start: existing.start,
            end: existing.end + (after?.[0].length ?? 0),
            text: "",
          });
        }
        continue;
      }

      const text = String(resolved.value);
      if (existing) {
        splices.push({ start: existing.start, end: existing.end, text });
      } else {
        // Imports belong in the existing block with no gap; anything else
        // gets a blank line before it. The blank line that already followed
        // the anchor stays put either way.
        const at = this.anchorFor(key);
        const isImport = this.theirs.units.get(key)?.isImport ?? false;
        splices.push({ start: at, end: at, text: isImport ? `${text}\n` : `\n${text}\n` });
      }
    }

    let result = this.ours.text;
    // Apply from the end so earlier offsets stay valid.
    for (const splice of splices.sort((a, b) => b.start - a.start)) {
      result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
    }
    return result.replace(/\n{3,}$/, "\n");
  }

  /**
   * Where to insert a declaration only the incoming branch has: after the
   * declaration that precedes it there, so related code stays together.
   * Imports go after the last import, since order among them is conventional
   * and putting one at the bottom of the file would be wrong.
   */
  private anchorFor(key: string): number {
    const incoming = this.theirs.units.get(key);

    if (incoming?.isImport) {
      const lastImport = [...this.ours.units.values()]
        .filter((unit) => unit.isImport)
        .sort((a, b) => a.end - b.end)
        .pop();
      if (lastImport) {
        const newline = /^\r?\n/.exec(this.ours.text.slice(lastImport.end));
        return lastImport.end + (newline?.[0].length ?? 0);
      }
      return 0;
      // Note: imports are inserted without a blank line (see serialize).
    }

    const indexInTheirs = this.theirs.order.indexOf(key);
    for (let i = indexInTheirs - 1; i >= 0; i--) {
      const predecessor = this.ours.units.get(this.theirs.order[i]);
      if (predecessor) {
        const newline = /^\r?\n/.exec(this.ours.text.slice(predecessor.end));
        return predecessor.end + (newline?.[0].length ?? 0);
      }
    }

    // Nothing to anchor to: append at the end.
    return this.ours.text.length;
  }
}

export function createJsEngine(): MergeEngine {
  return new JsMergeEngine();
}

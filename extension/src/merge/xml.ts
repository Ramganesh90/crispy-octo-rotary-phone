/**
 * Three-way merge for XML (`pom.xml`, `.csproj`, config files).
 *
 * Rebuilding an XML document from a parse tree reformats everything and turns
 * a one-line change into a diff nobody can review, so this engine never
 * reprints. It parses with a position-reporting SAX parser, records the exact
 * character span of every leaf's text and every attribute value, merges those
 * values, and replaces only the spans that changed. Everything else — comments,
 * indentation, attribute order, self-closing style, the XML declaration — comes
 * through byte for byte.
 *
 * Repeated siblings are matched by an identifying child (`artifactId`, `id`,
 * `name`, `key`), which is what makes a `pom.xml` dependency list merge
 * sensibly rather than by position.
 *
 * Mixed content — text and child elements inside the same element — falls back
 * to a text merge, because there is no single span to rewrite and guessing
 * would corrupt the document.
 */

import { SaxesParser, type SaxesTag } from "saxes";

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
  UnsupportedInput,
} from "./types";

/** Child elements used to identify a repeated sibling, in order. */
const IDENTITY_CHILDREN = ["artifactId", "id", "name", "key", "groupId"];

interface Value {
  /** Dotted path with identities, e.g. `project.dependencies.dependency[junit].version`. */
  path: string;
  text: string;
  /** Character range of the value in the source, replaced in place. */
  start: number;
  end: number;
}

/**
 * The document as parsed. Paths are computed in a second pass, because
 * whether a sibling needs disambiguating is only known once all of them have
 * been seen.
 */
interface Element {
  name: string;
  /** Set when siblings share this tag: `[identity]` or `#index`. */
  suffix?: string;
  textStart: number;
  text: string;
  children: Element[];
  attributes: { name: string; value: string; start: number; end: number }[];
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}

/**
 * Indexes every mergeable value in the document by path.
 *
 * Throws `UnsupportedInput` for shapes this cannot rewrite safely, so the
 * caller falls back to git's text merge.
 */
function parse(text: string | null, label: string): Map<string, Value> {
  if (text === null || text.trim() === "") {
    return new Map();
  }

  const parser = new SaxesParser({ position: true, fragment: false });
  const root: Element = {
    name: "#document",
    textStart: 0,
    text: "",
    children: [],
    attributes: [],
  };
  const stack: Element[] = [root];
  let failure: string | undefined;

  parser.on("error", (error) => {
    failure ??= error.message;
  });

  parser.on("opentag", (tag: SaxesTag) => {
    const parent = stack[stack.length - 1];
    if (parent !== root && parent.text.trim() !== "") {
      failure ??= `<${parent.name}> mixes text with child elements`;
    }

    const element: Element = {
      name: tag.name,
      textStart: parser.position,
      text: "",
      children: [],
      attributes: [],
    };

    // Locate each attribute's value span inside the tag just consumed, so it
    // can be replaced without touching the rest of the tag.
    const open = text.lastIndexOf("<" + tag.name, parser.position);
    const tagSource = text.slice(open, parser.position);
    for (const name of Object.keys(tag.attributes)) {
      const found = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "s").exec(tagSource);
      if (found) {
        const start = open + found.index + found[0].indexOf(found[1]) + 1;
        element.attributes.push({
          name,
          value: found[2],
          start,
          end: start + found[2].length,
        });
      }
    }

    parent.children.push(element);
    stack.push(element);
  });

  parser.on("text", (chunk: string) => {
    const element = stack[stack.length - 1];
    if (element === root) {
      return;
    }
    element.text += chunk;
    if (element.children.length > 0 && chunk.trim() !== "") {
      failure ??= `<${element.name}> mixes text with child elements`;
    }
  });

  parser.on("closetag", () => {
    stack.pop();
  });

  try {
    parser.write(text).close();
  } catch (error) {
    throw new UnsupportedInput(
      `${label} is not valid XML: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (failure) {
    throw new UnsupportedInput(`${label}: ${failure}; merge it as text`);
  }

  const values = new Map<string, Value>();
  for (const child of root.children) {
    collect(child, "", values);
  }
  return values;
}

/** An identifying child's text, used to tell repeated siblings apart. */
function identityOf(element: Element): string | undefined {
  for (const key of IDENTITY_CHILDREN) {
    const child = element.children.find(
      (c) => c.name === key && c.children.length === 0 && c.text.trim() !== "",
    );
    if (child) {
      return child.text.trim();
    }
  }
  return undefined;
}

/**
 * Walks the tree recording every mergeable value. Siblings sharing a tag are
 * distinguished by an identifying child where there is one, so a dependency
 * list matches up by name, and by position otherwise.
 */
function collect(element: Element, parentPath: string, values: Map<string, Value>): void {
  const base = parentPath === "" ? element.name : `${parentPath}.${element.name}`;
  const path = element.suffix === undefined ? base : `${base}${element.suffix}`;

  for (const attribute of element.attributes) {
    values.set(`${path}@${attribute.name}`, {
      path: `${path}@${attribute.name}`,
      text: attribute.value,
      start: attribute.start,
      end: attribute.end,
    });
  }

  if (element.children.length === 0) {
    values.set(path, {
      path,
      text: element.text,
      start: element.textStart,
      end: element.textStart + element.text.length,
    });
    return;
  }

  // Work out each child's suffix now that every sibling is known.
  const counts = new Map<string, number>();
  for (const child of element.children) {
    counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const child of element.children) {
    if ((counts.get(child.name) ?? 0) > 1) {
      const index = (seen.get(child.name) ?? 0) + 1;
      seen.set(child.name, index);
      const identity = identityOf(child);
      child.suffix = identity === undefined ? `#${index}` : `[${identity}]`;
    }
    collect(child, path, values);
  }
}

function side(values: Map<string, Value>, path: string): SideValue {
  const value = values.get(path);
  return value ? sideValue(true, value.text.trim()) : ABSENT;
}

function orderedPaths(ours: Map<string, Value>, theirs: Map<string, Value>): string[] {
  const ourPaths = [...ours.keys()];
  const seen = new Set(ourPaths);
  return [...ourPaths, ...[...theirs.keys()].filter((p) => !seen.has(p))];
}

export class XmlMergeEngine implements MergeEngine {
  readonly format = "xml" as const;

  private oursText = "";
  private oursValues = new Map<string, Value>();

  analyze(base: string | null, ours: string, theirs: string): MergeDocument {
    const baseValues = parse(base, "base");
    const oursValues = parse(ours, "ours");
    const theirsValues = parse(theirs, "theirs");

    this.oursText = ours;
    this.oursValues = oursValues;

    const root: MergeNode[] = orderedPaths(oursValues, theirsValues).map((path) => {
      const sides = {
        base: side(baseValues, path),
        ours: side(oursValues, path),
        theirs: side(theirsValues, path),
      };
      const status = statusOf(sides.base, sides.ours, sides.theirs);
      return {
        id: `$[${JSON.stringify(path)}]`,
        label: path,
        path: [path],
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
    return { format: "xml", root, ...countConflicts(root) };
  }

  serialize(doc: MergeDocument): string {
    // Replace spans from the end backwards so earlier offsets stay valid.
    const edits: { start: number; end: number; text: string }[] = [];
    const unsupported: string[] = [];

    for (const node of doc.root) {
      const resolved = resolvedValue(node);
      if (resolved === undefined || sameValue(resolved, node.sides.ours)) {
        continue;
      }
      const existing = this.oursValues.get(node.label);
      if (!existing) {
        // Adding or removing an element means writing structure, which this
        // engine does not do; the UI reports it rather than writing it wrong.
        unsupported.push(node.label);
        continue;
      }
      if (!resolved.present) {
        unsupported.push(node.label);
        continue;
      }

      const isAttribute = node.label.includes("@");
      const replacement = isAttribute
        ? escapeAttribute(String(resolved.value))
        : escapeText(String(resolved.value));

      // Keep the leading and trailing whitespace the original value had.
      const leading = /^\s*/.exec(existing.text)?.[0] ?? "";
      const trailing = /\s*$/.exec(existing.text)?.[0] ?? "";
      edits.push({
        start: existing.start,
        end: existing.end,
        text: isAttribute ? replacement : `${leading}${replacement}${trailing}`,
      });
    }

    let text = this.oursText;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    return text;
  }

  /** Paths whose resolution needs structural editing this engine will not do. */
  unsupportedChanges(doc: MergeDocument): string[] {
    return doc.root
      .filter((node) => {
        const resolved = resolvedValue(node);
        if (resolved === undefined || sameValue(resolved, node.sides.ours)) {
          return false;
        }
        return !this.oursValues.has(node.label) || !resolved.present;
      })
      .map((node) => node.label);
  }
}

export function createXmlEngine(): MergeEngine {
  return new XmlMergeEngine();
}

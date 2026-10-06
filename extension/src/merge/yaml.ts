/**
 * Structural three-way merge for YAML.
 *
 * The decision tree is the same one the JSON engine uses. Serializing edits
 * the *ours* document through the `yaml` package's AST, which round-trips
 * comments, quoting style and block/flow layout for untouched nodes.
 *
 * Two shapes are deliberately refused rather than merged, because merging
 * them key by key would silently change meaning:
 *
 *  - multi-document streams (`---` separated), where the document boundaries
 *    carry structure this model has no place for;
 *  - anchors and aliases, where editing one node can change another.
 *
 * Both fall back to git's text merge, which is the honest answer.
 */

import { isAlias, isNode, parseAllDocuments, parseDocument, visit, type Document } from "yaml";

import { buildNode, collectLeafEdits } from "./tree";
import {
  ABSENT,
  countConflicts,
  type MergeDocument,
  type MergeEngine,
  type SideValue,
  sideValue,
  UnsupportedInput,
} from "./types";

function hasAnchorOrAlias(doc: Document.Parsed): boolean {
  let found = false;
  visit(doc, (_key, node) => {
    if (isAlias(node) || (isNode(node) && node.anchor !== undefined)) {
      found = true;
      return visit.BREAK;
    }
    return undefined;
  });
  return found;
}

function parseSide(text: string | null, label: string): { value: SideValue; doc?: Document.Parsed } {
  if (text === null || text.trim() === "") {
    return { value: ABSENT };
  }

  const documents = parseAllDocuments(text);
  if (documents.length > 1) {
    throw new UnsupportedInput(
      `${label} holds ${documents.length} YAML documents; merge it as text`,
    );
  }

  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new UnsupportedInput(`${label} is not valid YAML: ${doc.errors[0].message}`);
  }
  if (hasAnchorOrAlias(doc)) {
    throw new UnsupportedInput(
      `${label} uses YAML anchors or aliases; merge it as text so references stay intact`,
    );
  }

  return { value: sideValue(true, doc.toJS()), doc };
}

export class YamlMergeEngine implements MergeEngine {
  readonly format = "yaml" as const;

  private oursDoc?: Document.Parsed;
  private oursText = "";

  analyze(base: string | null, ours: string, theirs: string): MergeDocument {
    const baseSide = parseSide(base, "base");
    const oursSide = parseSide(ours, "ours");
    const theirsSide = parseSide(theirs, "theirs");

    this.oursDoc = oursSide.doc;
    this.oursText = ours;

    const rootNode = buildNode(baseSide.value, oursSide.value, theirsSide.value);
    const root = rootNode.children ?? [rootNode];
    return { format: "yaml", root, ...countConflicts(root) };
  }

  serialize(doc: MergeDocument): string {
    if (!this.oursDoc) {
      return this.oursText;
    }
    const edits = collectLeafEdits(doc.root);
    if (edits.length === 0) {
      // Nothing to change: hand back the original bytes rather than a
      // re-rendering that might differ in trivia.
      return this.oursText;
    }

    // Edit a fresh copy every time. Serializing is called on each change, and
    // mutating one document would accumulate edits — a key deleted by an
    // earlier choice would stay deleted after the user changed their mind.
    const edited = parseDocument(this.oursText);
    for (const edit of edits) {
      if (edit.present) {
        edited.setIn(edit.path, edit.value);
      } else {
        edited.deleteIn(edit.path);
      }
    }
    return edited.toString({ lineWidth: 0 });
  }
}

export function createYamlEngine(): MergeEngine {
  return new YamlMergeEngine();
}

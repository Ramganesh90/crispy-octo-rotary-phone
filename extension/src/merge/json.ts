/**
 * Structural three-way merge for JSON and JSONC.
 *
 * The decision tree comes from `tree.ts`; this file only parses and
 * re-serializes. The result is produced by applying edits to the *ours* text
 * with `jsonc-parser`, so comments, trailing commas and the original
 * formatting of untouched regions survive the merge — something the Python
 * engine, which reprints the document, cannot do.
 */

import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";

import { annotateSuggestions } from "./suggest";
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

  /** Kept so `serialize` edits the original text rather than reprinting it. */
  private oursText = "";

  analyze(base: string | null, ours: string, theirs: string): MergeDocument {
    const rootNode = buildNode(
      parseSide(base, "base"),
      parseSide(ours, "ours"),
      parseSide(theirs, "theirs"),
    );
    this.oursText = ours;

    const root = rootNode.children ?? [rootNode];
    annotateSuggestions(root);
    return { format: "json", root, ...countConflicts(root) };
  }

  serialize(doc: MergeDocument): string {
    const formattingOptions = {
      ...detectIndent(this.oursText),
      eol: this.oursText.includes("\r\n") ? "\r\n" : "\n",
    };

    let text = this.oursText;
    for (const edit of collectLeafEdits(doc.root)) {
      text = applyEdits(
        text,
        modify(text, edit.path, edit.present ? edit.value : undefined, {
          formattingOptions,
        }),
      );
    }
    return text;
  }
}

export function createJsonEngine(): MergeEngine {
  return new JsonMergeEngine();
}

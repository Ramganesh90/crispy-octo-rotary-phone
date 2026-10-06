/**
 * Runs the shared corpus in `tests/corpus/` against the TypeScript engines.
 *
 * The same fixtures are run against the Python CLI by `tests/test_corpus.py`,
 * so a semantic change to either engine fails here or there.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createJsonEngine } from "../../merge/json";
import { createLinesEngine } from "../../merge/lines";
import { type MergeDocument, type MergeEngine, walk } from "../../merge/types";

interface Case {
  name: string;
  base: string | null;
  ours: string;
  theirs: string;
  expectedConflicts: string[];
  expectedValue: unknown;
}

const CORPUS_DIR = join(__dirname, "..", "..", "..", "..", "..", "tests", "corpus");

function loadCases(file: string): Case[] {
  return JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")) as Case[];
}

function conflictPaths(doc: MergeDocument): string[] {
  return [...walk(doc.root)].filter((n) => !n.children && n.status === "conflict").map((n) => n.id);
}

function runCase(engine: MergeEngine, testCase: Case): { doc: MergeDocument; text: string } {
  const doc = engine.analyze(testCase.base, testCase.ours, testCase.theirs);
  return { doc, text: engine.serialize(doc) };
}

for (const testCase of loadCases("json-cases.json")) {
  test(`json corpus: ${testCase.name}`, () => {
    const { doc, text } = runCase(createJsonEngine(), testCase);

    assert.deepEqual(conflictPaths(doc), testCase.expectedConflicts, "conflict paths");
    assert.equal(doc.conflictCount, testCase.expectedConflicts.length, "conflict count");
    // Unresolved conflicts leave the current branch's value in place, which is
    // what the CLI does when it reports a conflicting path.
    assert.deepEqual(JSON.parse(text), testCase.expectedValue, "merged value");
  });
}

for (const testCase of loadCases("lines-cases.json")) {
  test(`lines corpus: ${testCase.name}`, () => {
    const { doc, text } = runCase(createLinesEngine(), testCase);

    assert.deepEqual(conflictPaths(doc), testCase.expectedConflicts, "conflict paths");
    const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
    assert.deepEqual(lines, testCase.expectedValue, "merged lines");
  });
}

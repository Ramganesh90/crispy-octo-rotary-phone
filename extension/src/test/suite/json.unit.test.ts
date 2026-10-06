/**
 * Behavior specific to the TypeScript JSON engine: the decision tree it
 * builds for the UI, formatting and comment preservation, and the resolution
 * paths the webview drives.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createJsonEngine } from "../../merge/json";
import { detectFormat } from "../../merge/index";
import { type MergeNode, UnsupportedInput, walk } from "../../merge/types";

function find(nodes: MergeNode[], id: string): MergeNode {
  for (const node of walk(nodes)) {
    if (node.id === id) {
      return node;
    }
  }
  throw new Error(`no node ${id}`);
}

test("builds a tree whose leaves carry each side's value", () => {
  const engine = createJsonEngine();
  const doc = engine.analyze(
    '{"deps":{"react":"18.0.0"}}',
    '{"deps":{"react":"18.2.0"}}',
    '{"deps":{"react":"19.0.0"}}',
  );

  const node = find(doc.root, '$["deps"]["react"]');
  assert.equal(node.label, "react");
  assert.equal(node.status, "conflict");
  assert.equal(node.resolution.kind, "unresolved");
  assert.equal(node.sides.base.value, "18.0.0");
  assert.equal(node.sides.ours.value, "18.2.0");
  assert.equal(node.sides.theirs.value, "19.0.0");
  assert.equal(node.sides.ours.display, '"18.2.0"');
});

test("marks a key only the incoming branch added as theirs-only", () => {
  const engine = createJsonEngine();
  const doc = engine.analyze('{"a":1}', '{"a":1}', '{"a":1,"b":2}');
  assert.equal(find(doc.root, '$["b"]').status, "theirs-only");
  assert.equal(find(doc.root, '$["b"]').resolution.kind, "auto");
  assert.equal(doc.conflictCount, 0);
});

test("a deletion shows as a side that is not present", () => {
  const engine = createJsonEngine();
  const doc = engine.analyze('{"a":1,"b":2}', '{"a":1,"b":2}', '{"a":1}');
  const node = find(doc.root, '$["b"]');
  assert.equal(node.sides.theirs.present, false);
  assert.equal(node.status, "theirs-only");
  assert.deepEqual(JSON.parse(engine.serialize(doc)), { a: 1 });
});

test("choosing theirs on a conflict changes the serialized output", () => {
  const engine = createJsonEngine();
  const doc = engine.analyze('{"v":1}', '{"v":2}', '{"v":3}');
  assert.deepEqual(JSON.parse(engine.serialize(doc)), { v: 2 }, "unresolved keeps ours");

  find(doc.root, '$["v"]').resolution = { kind: "side", side: "theirs" };
  assert.deepEqual(JSON.parse(engine.serialize(doc)), { v: 3 });
});

test("a custom value is parsed as JSON when it can be", () => {
  const engine = createJsonEngine();
  const doc = engine.analyze('{"v":1}', '{"v":2}', '{"v":3}');

  find(doc.root, '$["v"]').resolution = { kind: "custom", text: "4" };
  assert.deepEqual(JSON.parse(engine.serialize(doc)), { v: 4 });

  find(doc.root, '$["v"]').resolution = { kind: "custom", text: "not json" };
  assert.deepEqual(JSON.parse(engine.serialize(doc)), { v: "not json" });
});

test("preserves ours indentation and key order", () => {
  const engine = createJsonEngine();
  const ours = '{\n    "z": 1,\n    "a": 1\n}\n';
  const doc = engine.analyze('{"z":1,"a":1}', ours, '{"z":1,"a":1,"m":2}');
  assert.equal(engine.serialize(doc), '{\n    "z": 1,\n    "a": 1,\n    "m": 2\n}\n');
});

test("preserves tab indentation", () => {
  const engine = createJsonEngine();
  const ours = '{\n\t"a": 1\n}\n';
  const doc = engine.analyze('{"a":1}', ours, '{"a":1,"b":2}');
  assert.match(engine.serialize(doc), /\n\t"b": 2/);
});

test("keeps comments in a JSONC file, which the Python engine cannot", () => {
  const engine = createJsonEngine();
  const ours = '{\n  // the app name\n  "name": "app"\n}\n';
  const doc = engine.analyze(
    '{"name":"app"}',
    ours,
    '{"name":"app","version":"1.0.0"}',
  );
  const text = engine.serialize(doc);
  assert.match(text, /\/\/ the app name/, "comment survives");
  assert.match(text, /"version": "1\.0\.0"/, "incoming key applied");
});

test("untouched regions are left byte for byte alone", () => {
  const engine = createJsonEngine();
  const ours = '{\n  "keep":   [1,2,\n     3],\n  "v": 1\n}\n';
  const doc = engine.analyze('{"keep":[1,2,3],"v":1}', ours, '{"keep":[1,2,3],"v":2}');
  const text = engine.serialize(doc);
  assert.match(text, /"keep":   \[1,2,\n     3\]/, "odd spacing preserved");
  assert.match(text, /"v": 2/);
});

test("invalid JSON is reported as unsupported so callers can fall back", () => {
  const engine = createJsonEngine();
  assert.throws(() => engine.analyze("{}", "{not json", "{}"), UnsupportedInput);
});

test("an empty side counts as absent rather than invalid", () => {
  const engine = createJsonEngine();
  const doc = engine.analyze("", '{"a":1}', '{"b":2}');
  assert.deepEqual(JSON.parse(engine.serialize(doc)), { a: 1, b: 2 });
});

test("detects formats by filename", () => {
  assert.equal(detectFormat("package.json"), "json");
  assert.equal(detectFormat("src/tsconfig.jsonc"), "json");
  assert.equal(detectFormat("/abs/path/.babelrc"), "json");
  assert.equal(detectFormat("package-lock.json"), "lockfile");
  assert.equal(detectFormat(".gitignore"), "lines");
  assert.equal(detectFormat("CODEOWNERS"), "lines");
  assert.equal(detectFormat(".github/workflows/ci.yml"), "yaml");
  assert.equal(detectFormat("src/app.ts"), null);
});

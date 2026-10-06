import assert from "node:assert/strict";
import { test } from "node:test";

import { createLockfileEngine, regenerateCommand } from "../../merge/lockfile";
import { type MergeNode, UnsupportedInput, walk } from "../../merge/types";
import { createYamlEngine } from "../../merge/yaml";

function find(nodes: MergeNode[], id: string): MergeNode {
  for (const node of walk(nodes)) {
    if (node.id === id) {
      return node;
    }
  }
  throw new Error(`no node ${id}`);
}

// ----------------------------------------------------------------------- yaml

test("merges keys added on both sides of a YAML mapping", () => {
  const engine = createYamlEngine();
  const doc = engine.analyze(
    "name: ci\njobs:\n  build: node\n",
    "name: ci\njobs:\n  build: node\n  lint: eslint\n",
    "name: ci\njobs:\n  build: node\n  test: vitest\n",
  );
  assert.equal(doc.conflictCount, 0);

  const text = engine.serialize(doc);
  assert.match(text, /lint: eslint/);
  assert.match(text, /test: vitest/);
});

test("reports a key both sides changed as a conflict", () => {
  const engine = createYamlEngine();
  const doc = engine.analyze(
    "runs-on: ubuntu-20.04\n",
    "runs-on: ubuntu-22.04\n",
    "runs-on: ubuntu-24.04\n",
  );
  assert.equal(doc.conflictCount, 1);
  const node = find(doc.root, '$["runs-on"]');
  assert.equal(node.sides.theirs.value, "ubuntu-24.04");

  node.resolution = { kind: "side", side: "theirs" };
  assert.match(engine.serialize(doc), /runs-on: ubuntu-24\.04/);
});

test("keeps comments on untouched lines", () => {
  const engine = createYamlEngine();
  const ours = "# the workflow name\nname: ci\njobs:\n  build: node\n";
  const doc = engine.analyze(
    "name: ci\njobs:\n  build: node\n",
    ours,
    "name: ci\njobs:\n  build: node\n  test: vitest\n",
  );
  const text = engine.serialize(doc);
  assert.match(text, /# the workflow name/);
  assert.match(text, /test: vitest/);
});

test("returns the original text byte for byte when nothing changed", () => {
  const engine = createYamlEngine();
  const ours = "# keep me\nname:    ci\n";
  const doc = engine.analyze("name: ci\n", ours, "name: ci\n");
  assert.equal(engine.serialize(doc), ours);
});

test("changing a choice back does not leave an earlier deletion applied", () => {
  const engine = createYamlEngine();
  const doc = engine.analyze("a: 1\nb: 2\n", "a: 1\nb: 2\n", "a: 1\n");
  const node = find(doc.root, '$["b"]');

  assert.doesNotMatch(engine.serialize(doc), /b:/, "theirs deleted it");

  node.resolution = { kind: "side", side: "ours" };
  assert.match(engine.serialize(doc), /b: 2/, "choosing ours restores it");
});

test("refuses a multi-document stream rather than merging it", () => {
  const engine = createYamlEngine();
  assert.throws(
    () => engine.analyze("a: 1\n", "a: 2\n---\nb: 1\n", "a: 3\n"),
    UnsupportedInput,
  );
});

test("refuses anchors and aliases, which key-by-key edits would break", () => {
  const engine = createYamlEngine();
  assert.throws(
    () =>
      engine.analyze(
        "defaults: &d\n  shell: bash\njob:\n  <<: *d\n",
        "defaults: &d\n  shell: bash\njob:\n  <<: *d\n  run: a\n",
        "defaults: &d\n  shell: zsh\njob:\n  <<: *d\n",
      ),
    UnsupportedInput,
  );
});

test("reports invalid YAML as unsupported", () => {
  const engine = createYamlEngine();
  assert.throws(() => engine.analyze("a: 1\n", "a: [1, 2\n", "a: 3\n"), UnsupportedInput);
});

// ------------------------------------------------------------------- lockfile

test("a lockfile is one whole-file decision, not a key-by-key merge", () => {
  const engine = createLockfileEngine();
  const ours = JSON.stringify({ name: "a", version: "1", packages: { "": {}, x: {} } });
  const theirs = JSON.stringify({ name: "a", version: "2", packages: { "": {} } });
  const doc = engine.analyze(null, ours, theirs);

  assert.equal(doc.root.length, 1);
  assert.equal(doc.conflictCount, 1);
  assert.equal(doc.root[0].sides.ours.display, "2 packages");
  assert.equal(doc.root[0].sides.theirs.display, "1 package");
});

test("a lockfile resolves to the chosen side verbatim", () => {
  const engine = createLockfileEngine();
  const ours = '{"version":"1"}';
  const theirs = '{"version":"2"}';
  const doc = engine.analyze(null, ours, theirs);

  assert.equal(engine.serialize(doc), ours, "unresolved keeps ours");
  doc.root[0].resolution = { kind: "side", side: "theirs" };
  assert.equal(engine.serialize(doc), theirs);
});

test("a corrupt lockfile falls back rather than being written back out", () => {
  const engine = createLockfileEngine();
  assert.throws(() => engine.analyze(null, "{broken", "{}"), UnsupportedInput);
});

test("names the command that regenerates a lockfile", () => {
  assert.deepEqual(regenerateCommand("package-lock.json"), {
    command: "npm",
    args: ["install", "--package-lock-only"],
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { arrayStrategy } from "../../merge/arrays";
import { createJsonEngine } from "../../merge/json";
import { compareVersions, parseVersion, suggestFor } from "../../merge/suggest";
import { type MergeNode, walk } from "../../merge/types";

function find(nodes: MergeNode[], id: string): MergeNode {
  for (const node of walk(nodes)) {
    if (node.id === id) {
      return node;
    }
  }
  throw new Error(`no node ${id}; have ${[...walk(nodes)].map((n) => n.id).join(", ")}`);
}

function merge(base: unknown, ours: unknown, theirs: unknown) {
  const engine = createJsonEngine();
  const doc = engine.analyze(
    base === null ? null : JSON.stringify(base),
    JSON.stringify(ours, null, 2),
    JSON.stringify(theirs),
  );
  return { engine, doc, text: () => engine.serialize(doc) };
}

// --------------------------------------------------------------- strategy

test("scalar arrays merge as a set", () => {
  assert.deepEqual(arrayStrategy([["a"], ["a", "b"], ["a", "c"]]), { kind: "set" });
});

test("object arrays are keyed by an identifying field", () => {
  const sides = [
    [{ uses: "checkout" }],
    [{ uses: "checkout" }, { uses: "setup-node" }],
    [{ uses: "checkout" }],
  ];
  assert.deepEqual(arrayStrategy(sides), { kind: "keyed", key: "uses" });
});

test("repeated entries fall back to atomic rather than collapsing", () => {
  const strategy = arrayStrategy([["a"], ["a", "a"], ["a"]]);
  assert.equal(strategy.kind, "atomic");
});

test("mixed element kinds fall back to atomic", () => {
  const strategy = arrayStrategy([[], ["a"], [{ id: 1 }]]);
  assert.equal(strategy.kind, "atomic");
});

test("objects with no identifying field fall back to atomic", () => {
  const strategy = arrayStrategy([[], [{ a: 1 }], [{ b: 2 }]]);
  assert.equal(strategy.kind, "atomic");
});

test("a non-unique identity field is rejected", () => {
  const sides = [[], [{ name: "x" }, { name: "x" }], [{ name: "y" }]];
  assert.equal(arrayStrategy(sides).kind, "atomic");
});

// ------------------------------------------------------------ set merging

test("both branches appending to a list is no longer a conflict", () => {
  const { doc, text } = merge(
    { include: ["src"] },
    { include: ["src", "tests"] },
    { include: ["src", "scripts"] },
  );
  assert.equal(doc.conflictCount, 0);
  assert.deepEqual(JSON.parse(text()).include, ["src", "tests", "scripts"]);
});

test("an entry removed on one side is removed from the merge", () => {
  const { doc, text } = merge(
    { lib: ["dom", "es2020"] },
    { lib: ["dom", "es2020"] },
    { lib: ["dom"] },
  );
  assert.equal(doc.conflictCount, 0);
  assert.deepEqual(JSON.parse(text()).lib, ["dom"]);
});

test("list entries are listed individually with their origin", () => {
  const { doc } = merge({ files: ["a"] }, { files: ["a", "b"] }, { files: ["a", "c"] });
  const array = find(doc.root, '$["files"]');
  assert.equal(array.kind, "array");
  assert.equal(array.arrayStrategy, "merged as a list");
  assert.deepEqual(
    array.children?.map((c) => [c.label, c.status]),
    [
      ["a", "unchanged"],
      ["b", "ours-only"],
      ["c", "theirs-only"],
    ],
  );
});

test("an array kept whole overrides its entries", () => {
  const { doc, text } = merge({ files: ["a"] }, { files: ["a", "b"] }, { files: ["a", "c"] });
  find(doc.root, '$["files"]').resolution = { kind: "side", side: "theirs" };
  assert.deepEqual(JSON.parse(text()).files, ["a", "c"]);
});

// ---------------------------------------------------------- keyed merging

test("records are matched by identity and merged field by field", () => {
  const { doc, text } = merge(
    { steps: [{ uses: "checkout", with: { depth: 1 } }] },
    {
      steps: [
        { uses: "checkout", with: { depth: 1 }, name: "Check out" },
        { uses: "setup-node" },
      ],
    },
    { steps: [{ uses: "checkout", with: { depth: 0 } }, { uses: "cache" }] },
  );

  assert.equal(doc.conflictCount, 0, "no field was changed on both sides");
  const steps = JSON.parse(text()).steps;
  assert.deepEqual(steps.map((s: { uses: string }) => s.uses), [
    "checkout",
    "setup-node",
    "cache",
  ]);
  assert.equal(steps[0].with.depth, 0, "their change to a nested field applied");
  assert.equal(steps[0].name, "Check out", "our added field kept");
});

test("a field both branches changed inside a record still conflicts", () => {
  const { doc } = merge(
    { steps: [{ uses: "checkout", ref: "main" }] },
    { steps: [{ uses: "checkout", ref: "develop" }] },
    { steps: [{ uses: "checkout", ref: "release" }] },
  );
  assert.equal(doc.conflictCount, 1);
  const node = find(doc.root, '$["steps"]["checkout"]["ref"]');
  assert.equal(node.sides.theirs.value, "release");
});

test("an unresolved entry leaves the whole array as ours", () => {
  const { doc, text } = merge(
    { steps: [{ name: "a", run: "1" }] },
    { steps: [{ name: "a", run: "2" }] },
    { steps: [{ name: "a", run: "3" }, { name: "b" }] },
  );
  assert.equal(doc.unresolvedCount, 1);
  assert.deepEqual(JSON.parse(text()).steps, [{ name: "a", run: "2" }]);

  find(doc.root, '$["steps"]["a"]["run"]').resolution = { kind: "side", side: "theirs" };
  const steps = JSON.parse(text()).steps;
  assert.deepEqual(steps, [{ name: "a", run: "3" }, { name: "b" }]);
});

test("an array with repeated entries is still offered as a whole choice", () => {
  const { doc } = merge({ a: ["x"] }, { a: ["x", "x"] }, { a: ["x", "y"] });
  const node = find(doc.root, '$["a"]');
  assert.equal(node.children, undefined, "stays atomic");
  assert.equal(node.status, "conflict");
  assert.match(node.arrayStrategy ?? "", /repeated entries/);
});

// -------------------------------------------------------------- suggestions

test("parses version strings with range operators", () => {
  assert.deepEqual(parseVersion("^18.2.0")?.parts, [18, 2, 0]);
  assert.deepEqual(parseVersion(">=20")?.parts, [20, 0, 0]);
  assert.deepEqual(parseVersion("v1.2.3")?.parts, [1, 2, 3]);
  assert.equal(parseVersion("workspace:*"), undefined);
  assert.equal(parseVersion(42), undefined);
});

test("orders versions including prereleases", () => {
  const v = (s: string) => parseVersion(s)!;
  assert.ok(compareVersions(v("1.2.0"), v("1.10.0")) < 0);
  assert.ok(compareVersions(v("2.0.0"), v("1.99.99")) > 0);
  assert.ok(compareVersions(v("1.0.0-rc.1"), v("1.0.0")) < 0);
  assert.equal(compareVersions(v("^1.2.3"), v("~1.2.3")), 0);
});

test("recommends the newer version on a dependency conflict", () => {
  const { doc } = merge(
    { dependencies: { react: "18.0.0" } },
    { dependencies: { react: "18.2.0" } },
    { dependencies: { react: "18.3.0" } },
  );
  const node = find(doc.root, '$["dependencies"]["react"]');
  assert.deepEqual(node.suggestion, {
    side: "theirs",
    reason: "newer (18.2.0 → 18.3.0)",
  });
});

test("says so when the newer version is a major bump", () => {
  const { doc } = merge(
    { dependencies: { react: "18.0.0" } },
    { dependencies: { react: "19.0.0" } },
    { dependencies: { react: "18.3.0" } },
  );
  const node = find(doc.root, '$["dependencies"]["react"]');
  assert.equal(node.suggestion?.side, "ours");
  assert.match(node.suggestion?.reason ?? "", /major bump/);
});

test("says nothing when the values are not versions", () => {
  const { doc } = merge({ name: "a" }, { name: "b" }, { name: "c" });
  assert.equal(find(doc.root, '$["name"]').suggestion, undefined);
});

test("a suggestion never resolves the conflict by itself", () => {
  const { doc } = merge(
    { dependencies: { react: "18.0.0" } },
    { dependencies: { react: "18.2.0" } },
    { dependencies: { react: "18.3.0" } },
  );
  const node = find(doc.root, '$["dependencies"]["react"]');
  assert.ok(node.suggestion);
  assert.equal(node.resolution.kind, "unresolved");
  assert.equal(doc.unresolvedCount, 1);
});

test("suggestFor ignores containers and non-conflicts", () => {
  const { doc } = merge({ a: { v: "1.0.0" } }, { a: { v: "1.1.0" } }, { a: { v: "1.1.0" } });
  assert.equal(suggestFor(find(doc.root, '$["a"]')), undefined);
});

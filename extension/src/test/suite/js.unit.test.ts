import assert from "node:assert/strict";
import { test } from "node:test";

import { detectFormat } from "../../merge/index";
import { createJsEngine } from "../../merge/js";
import { type MergeDocument, type MergeEngine, UnsupportedInput } from "../../merge/types";

function run(base: string | null, ours: string, theirs: string) {
  const engine: MergeEngine = createJsEngine();
  const doc: MergeDocument = engine.analyze(base, ours, theirs);
  return { engine, doc, text: () => engine.serialize(doc) };
}

const APP = `import React from "react";

export function App() {
  return <div>hi</div>;
}
`;

// ---------------------------------------------------------------- detection

test("detects JavaScript, JSX and TypeScript by extension", () => {
  for (const file of ["a.js", "a.jsx", "a.mjs", "a.cjs", "a.ts", "a.tsx", "a.mts"]) {
    assert.equal(detectFormat(file), "js", file);
  }
  assert.equal(detectFormat("a.json"), "json", "json is still json");
  assert.equal(detectFormat("a.css"), null);
});

// ------------------------------------------------------- declaration level

test("each branch adding a function is not a conflict", () => {
  const { doc, text } = run(
    APP,
    `${APP}\nexport function Footer() {\n  return <footer/>;\n}\n`,
    `${APP}\nexport function Header() {\n  return <header/>;\n}\n`,
  );
  assert.equal(doc.conflictCount, 0);

  const merged = text();
  assert.match(merged, /function Footer/);
  assert.match(merged, /function Header/);
  assert.match(merged, /function App/);
});

test("each branch editing a different function is not a conflict", () => {
  const base = `function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n`;
  const { doc, text } = run(
    base,
    base.replace("return 1;", "return 10;"),
    base.replace("return 2;", "return 20;"),
  );
  assert.equal(doc.conflictCount, 0);
  assert.match(text(), /return 10;/);
  assert.match(text(), /return 20;/);
});

test("each branch adding an import is not a conflict, and imports stay together", () => {
  const base = `import a from "a";\n\nexport const x = 1;\n`;
  const { doc, text } = run(
    base,
    `import a from "a";\nimport b from "b";\n\nexport const x = 1;\n`,
    `import a from "a";\nimport c from "c";\n\nexport const x = 1;\n`,
  );
  assert.equal(doc.conflictCount, 0);

  const merged = text();
  const lines = merged.split("\n");
  const cAt = lines.findIndex((l) => l.includes('from "c"'));
  const constAt = lines.findIndex((l) => l.includes("export const x"));
  assert.ok(cAt !== -1 && cAt < constAt, "the incoming import landed with the imports");
});

test("a function only the incoming branch deleted is deleted", () => {
  const base = `function keep() {}\n\nfunction gone() {}\n`;
  const { doc, text } = run(base, base, "function keep() {}\n");
  assert.equal(doc.conflictCount, 0);
  assert.doesNotMatch(text(), /function gone/);
  assert.match(text(), /function keep/);
});

test("a declaration is identified by name, so moving it is not a rewrite", () => {
  const base = `function a() {}\n\nfunction b() {}\n`;
  // Theirs reorders and edits b; ours is untouched.
  const { doc, text } = run(base, base, `function b() {\n  return 2;\n}\n\nfunction a() {}\n`);
  assert.equal(doc.conflictCount, 0);
  assert.match(text(), /function b\(\) \{\n {2}return 2;\n\}/);
});

// --------------------------------------------- line merge inside a declaration

test("both branches editing different lines of one function merges cleanly", () => {
  const base =
    "export function calc(a, b) {\n  const x = a * 2;\n  const y = b * 2;\n  const z = x + y;\n  return z;\n}\n";
  const { doc, text } = run(
    base,
    base.replace("a * 2", "a * 3"),
    base.replace("x + y;", "x + y + 1;"),
  );

  // This is the case that would make a declaration-only merge worse than git.
  assert.equal(doc.conflictCount, 0, "must not conflict");
  const merged = text();
  assert.match(merged, /a \* 3/, "our edit applied");
  assert.match(merged, /x \+ y \+ 1/, "their edit applied");
});

test("both branches editing the same line conflicts, and says why", () => {
  const base = "function f() {\n  return 1;\n}\n";
  const { doc } = run(
    base,
    base.replace("return 1;", "return 2;"),
    base.replace("return 1;", "return 3;"),
  );
  assert.equal(doc.conflictCount, 1);
  assert.equal(doc.root[0].resolution.kind, "unresolved");
  assert.match(doc.root[0].arrayStrategy ?? "", /same lines/);
});

test("an inner merge is reported as such rather than silently", () => {
  const base =
    "function f() {\n  const a = 1;\n  let t = 0;\n  t += a;\n  const b = 2;\n  return t + b;\n}\n";
  const { doc } = run(
    base,
    base.replace("const a = 1;", "const a = 11;"),
    base.replace("const b = 2;", "const b = 22;"),
  );
  assert.equal(doc.conflictCount, 0);
  assert.match(doc.root[0].arrayStrategy ?? "", /merged line by line/);
});

test("edits on adjacent lines conflict, exactly as git's own merge does", () => {
  // Verified against `git merge-file`, which conflicts on this input too:
  // changes with no unchanged line between them cannot be told apart. Matching
  // git here is the point — this engine must never be worse than the merge the
  // user would otherwise have got.
  const base = "function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n";
  const { doc } = run(
    base,
    base.replace("const a = 1;", "const a = 11;"),
    base.replace("const b = 2;", "const b = 22;"),
  );
  assert.equal(doc.conflictCount, 1);
  assert.match(doc.root[0].arrayStrategy ?? "", /same lines/);
});

test("an unresolved conflict leaves our version in place", () => {
  const base = "function f() {\n  return 1;\n}\n";
  const ours = base.replace("return 1;", "return 2;");
  const { text } = run(base, ours, base.replace("return 1;", "return 3;"));
  assert.equal(text(), ours);
});

test("choosing theirs on a conflicting declaration replaces just that declaration", () => {
  const base = "const keep = 1;\n\nfunction f() {\n  return 1;\n}\n";
  const { doc, text } = run(
    base,
    base.replace("return 1;", "return 2;"),
    base.replace("return 1;", "return 3;"),
  );
  const conflict = doc.root.find((n) => n.status === "conflict")!;
  conflict.resolution = { kind: "side", side: "theirs" };

  const merged = text();
  assert.match(merged, /return 3;/);
  assert.match(merged, /const keep = 1;/, "the untouched declaration is intact");
});

// ------------------------------------------------------------ formatting

test("nothing but the changed declaration is touched", () => {
  const ours = `// a header comment\n\nimport  a  from "a";   // odd spacing kept\n\nfunction untouched() {\n    return    1;\n}\n\nfunction changed() {\n  return 1;\n}\n`;
  const base = ours;
  const { text } = run(base, ours, ours.replace("function changed() {\n  return 1;", "function changed() {\n  return 2;"));

  const merged = text();
  assert.match(merged, /\/\/ a header comment/);
  assert.match(merged, /import {2}a {2}from "a"; {3}\/\/ odd spacing kept/);
  assert.match(merged, /return {4}1;/, "untouched function keeps its odd spacing");
  assert.match(merged, /function changed\(\) \{\n {2}return 2;/);
});

test("a JSDoc block travels with the function it documents", () => {
  const base = `/** Adds. */\nexport function add(a, b) {\n  return a + b;\n}\n`;
  const { text } = run(
    base,
    base,
    `/** Adds two numbers. */\nexport function add(a, b) {\n  return a + b;\n}\n`,
  );
  assert.match(text(), /\/\*\* Adds two numbers\. \*\//);
  assert.doesNotMatch(text(), /\/\*\* Adds\. \*\//, "the old doc comment is replaced, not duplicated");
});

test("JSX and TypeScript both parse", () => {
  const tsx = `type Props = { name: string };\n\nexport const Hi = ({ name }: Props) => <p>{name}</p>;\n`;
  const { doc, text } = run(tsx, tsx, tsx.replace("<p>{name}</p>", "<h1>{name}</h1>"));
  assert.equal(doc.conflictCount, 0);
  assert.match(text(), /<h1>\{name\}<\/h1>/);
});

test("a file with no common ancestor keeps both branches' declarations", () => {
  const { doc, text } = run(null, "function a() {}\n", "function b() {}\n");
  assert.equal(doc.conflictCount, 0);
  assert.match(text(), /function a/);
  assert.match(text(), /function b/);
});

test("a syntax error falls back rather than guessing", () => {
  const engine = createJsEngine();
  assert.throws(
    () => engine.analyze("const a = 1;\n", "function f( {\n", "const a = 1;\n"),
    UnsupportedInput,
  );
});

test("top-level statements with no name are still tracked", () => {
  const base = `console.log("a");\nconsole.log("b");\n`;
  const { doc, text } = run(base, base, `console.log("a");\nconsole.log("B");\n`);
  assert.equal(doc.conflictCount, 0);
  assert.match(text(), /console\.log\("B"\)/);
});

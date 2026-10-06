import assert from "node:assert/strict";
import { test } from "node:test";

import { createDotenvEngine } from "../../merge/dotenv";
import { detectFormat } from "../../merge/index";
import { createTomlEngine } from "../../merge/toml";
import { UnsupportedInput } from "../../merge/types";

// ----------------------------------------------------------------- detection

test("detects the new formats by filename", () => {
  assert.equal(detectFormat("pyproject.toml"), "toml");
  assert.equal(detectFormat("crates/core/Cargo.toml"), "toml");
  assert.equal(detectFormat(".env"), "dotenv");
  assert.equal(detectFormat(".env.production"), "dotenv");
  assert.equal(detectFormat("environment.ts"), null);
});

// --------------------------------------------------------------------- dotenv

test("env files merge key by key, not line by line", () => {
  const engine = createDotenvEngine();
  const doc = engine.analyze(
    "API_URL=http://localhost\nDEBUG=false\n",
    "API_URL=http://localhost\nDEBUG=false\nCACHE=redis\n",
    "API_URL=http://localhost\nDEBUG=false\nQUEUE=sqs\n",
  );
  assert.equal(doc.conflictCount, 0);

  const text = engine.serialize(doc);
  assert.match(text, /^CACHE=redis$/m);
  assert.match(text, /^QUEUE=sqs$/m);
});

test("a variable both branches changed conflicts", () => {
  const engine = createDotenvEngine();
  const doc = engine.analyze("PORT=3000\n", "PORT=4000\n", "PORT=5000\n");
  assert.equal(doc.conflictCount, 1);
  assert.equal(doc.root[0].label, "PORT");

  doc.root[0].resolution = { kind: "side", side: "theirs" };
  assert.match(engine.serialize(doc), /^PORT=5000$/m);
});

test("comments, blank lines and export prefixes survive", () => {
  const engine = createDotenvEngine();
  const ours = "# API settings\nexport API_URL=http://localhost\n\n# flags\nDEBUG=false\n";
  const doc = engine.analyze(
    "export API_URL=http://localhost\nDEBUG=false\n",
    ours,
    "export API_URL=https://prod\nDEBUG=false\n",
  );
  const text = engine.serialize(doc);
  assert.match(text, /# API settings/);
  assert.match(text, /# flags/);
  assert.match(text, /^export API_URL=https:\/\/prod$/m, "export prefix kept");
});

test("a variable the incoming branch removed is removed", () => {
  const engine = createDotenvEngine();
  const doc = engine.analyze("A=1\nB=2\n", "A=1\nB=2\n", "A=1\n");
  const text = engine.serialize(doc);
  assert.doesNotMatch(text, /^B=/m);
  assert.match(text, /^A=1$/m);
});

test("quoted values with an = inside are left intact", () => {
  const engine = createDotenvEngine();
  const ours = 'TOKEN="abc=def"\n';
  const doc = engine.analyze(ours, ours, 'TOKEN="abc=def"\nEXTRA=1\n');
  const text = engine.serialize(doc);
  assert.match(text, /^TOKEN="abc=def"$/m);
  assert.match(text, /^EXTRA=1$/m);
});

// ----------------------------------------------------------------------- toml

test("dependency bumps in different tables merge cleanly", () => {
  const engine = createTomlEngine();
  const base = '[dependencies]\nserde = "1.0.100"\ntokio = "1.0"\n';
  const ours = '[dependencies]\nserde = "1.0.200"\ntokio = "1.0"\n';
  const theirs = '[dependencies]\nserde = "1.0.100"\ntokio = "1.5"\n';

  const doc = engine.analyze(base, ours, theirs);
  assert.equal(doc.conflictCount, 0);

  const text = engine.serialize(doc);
  assert.match(text, /serde = "1\.0\.200"/);
  assert.match(text, /tokio = "1\.5"/);
});

test("the same dependency bumped on both sides conflicts, and recommends the newer", () => {
  const engine = createTomlEngine();
  const doc = engine.analyze(
    '[dependencies]\nserde = "1.0.100"\n',
    '[dependencies]\nserde = "1.0.150"\n',
    '[dependencies]\nserde = "1.0.200"\n',
  );
  assert.equal(doc.conflictCount, 1);
  const node = doc.root.find((n) => n.label === "dependencies.serde")!;
  assert.equal(node.suggestion?.side, "theirs");

  node.resolution = { kind: "side", side: "theirs" };
  assert.match(engine.serialize(doc), /serde = "1\.0\.200"/);
});

test("comments and trailing comments survive a value change", () => {
  const engine = createTomlEngine();
  const ours = '# the build\n[tool.poetry]\nversion = "1.0.0"  # bump me\n';
  const doc = engine.analyze(
    '[tool.poetry]\nversion = "1.0.0"\n',
    ours,
    '[tool.poetry]\nversion = "2.0.0"\n',
  );
  const text = engine.serialize(doc);
  assert.match(text, /# the build/);
  assert.match(text, /version = "2\.0\.0"\s+# bump me/, "trailing comment kept");
});

test("a key added by the incoming branch lands in the right table", () => {
  const engine = createTomlEngine();
  const ours = '[dependencies]\nserde = "1.0"\n\n[dev-dependencies]\nrstest = "0.1"\n';
  const doc = engine.analyze(
    '[dependencies]\nserde = "1.0"\n\n[dev-dependencies]\nrstest = "0.1"\n',
    ours,
    '[dependencies]\nserde = "1.0"\nanyhow = "1.0"\n\n[dev-dependencies]\nrstest = "0.1"\n',
  );
  const text = engine.serialize(doc);
  const lines = text.split("\n");
  const depsAt = lines.indexOf("[dependencies]");
  const devAt = lines.indexOf("[dev-dependencies]");
  const anyhowAt = lines.findIndex((l) => l.startsWith("anyhow"));
  assert.ok(anyhowAt > depsAt && anyhowAt < devAt, `anyhow landed at ${anyhowAt}`);
});

test("a table the incoming branch introduces is created", () => {
  const engine = createTomlEngine();
  const ours = '[dependencies]\nserde = "1.0"\n';
  const doc = engine.analyze(ours, ours, `${ours}\n[features]\ndefault = ["std"]\n`);
  const text = engine.serialize(doc);
  assert.match(text, /\[features\]/);
  assert.match(text, /default = \["std"\]/);
});

test("indentation and spacing around the equals sign are preserved", () => {
  const engine = createTomlEngine();
  const ours = '[a]\n  key   =   "old"\n';
  const doc = engine.analyze('[a]\nkey = "old"\n', ours, '[a]\nkey = "new"\n');
  assert.match(engine.serialize(doc), /^ {2}key {3}= {3}"new"$/m);
});

test("an array of tables falls back rather than guessing", () => {
  const engine = createTomlEngine();
  const withArray = '[[bin]]\nname = "a"\n';
  assert.throws(() => engine.analyze(withArray, withArray, withArray), UnsupportedInput);
});

test("a value spanning several lines falls back", () => {
  const engine = createTomlEngine();
  const multi = '[a]\nlist = [\n  "one",\n  "two",\n]\n';
  assert.throws(() => engine.analyze(multi, multi, multi), UnsupportedInput);
});

test("a key removed by the incoming branch is removed", () => {
  const engine = createTomlEngine();
  const ours = '[deps]\na = "1"\nb = "2"\n';
  const doc = engine.analyze(ours, ours, '[deps]\na = "1"\n');
  const text = engine.serialize(doc);
  assert.doesNotMatch(text, /^b = /m);
  assert.match(text, /^a = "1"$/m);
});

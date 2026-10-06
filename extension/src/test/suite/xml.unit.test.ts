import assert from "node:assert/strict";
import { test } from "node:test";

import { detectFormat } from "../../merge/index";
import { UnsupportedInput } from "../../merge/types";
import { createXmlEngine, XmlMergeEngine } from "../../merge/xml";

const POM = (serde: string, junit: string, extra = "") => `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <!-- the module -->
  <artifactId>demo</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>serde</artifactId>
      <version>${serde}</version>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>${junit}</version>
    </dependency>${extra}
  </dependencies>
</project>
`;

test("detects XML by filename", () => {
  assert.equal(detectFormat("pom.xml"), "xml");
  assert.equal(detectFormat("src/App.csproj"), "xml");
  assert.equal(detectFormat("Directory.Build.props"), "xml");
  assert.equal(detectFormat("readme.md"), null);
});

test("different dependencies bumped on each side merge cleanly", () => {
  const engine = createXmlEngine();
  const doc = engine.analyze(POM("1.0.0", "4.12"), POM("1.1.0", "4.12"), POM("1.0.0", "4.13"));
  assert.equal(doc.conflictCount, 0);

  const text = engine.serialize(doc);
  assert.match(text, /<version>1\.1\.0<\/version>/);
  assert.match(text, /<version>4\.13<\/version>/);
});

test("repeated siblings are matched by their identifying child, not position", () => {
  const engine = createXmlEngine();
  const doc = engine.analyze(POM("1.0.0", "4.12"), POM("1.1.0", "4.12"), POM("1.0.0", "4.13"));
  const paths = doc.root.map((n) => n.label);
  assert.ok(
    paths.some((p) => p.includes("[serde]")),
    `expected an identity-keyed path, got ${paths.join(", ")}`,
  );
});

test("the same version bumped on both sides conflicts and recommends the newer", () => {
  const engine = createXmlEngine();
  const doc = engine.analyze(POM("1.0.0", "4.12"), POM("1.1.0", "4.12"), POM("1.2.0", "4.12"));
  assert.equal(doc.conflictCount, 1);

  const node = doc.root.find((n) => n.status === "conflict")!;
  assert.equal(node.suggestion?.side, "theirs");

  node.resolution = { kind: "side", side: "theirs" };
  assert.match(engine.serialize(doc), /<version>1\.2\.0<\/version>/);
});

test("comments, the declaration and indentation come through untouched", () => {
  const engine = createXmlEngine();
  const ours = POM("1.0.0", "4.12");
  const doc = engine.analyze(ours, ours, POM("2.0.0", "4.12"));
  const text = engine.serialize(doc);

  assert.match(text, /<\?xml version="1\.0"\?>/);
  assert.match(text, /<!-- the module -->/);
  assert.match(text, /^ {6}<version>2\.0\.0<\/version>$/m, "indentation preserved");
  // Everything except the one changed value is byte for byte identical.
  assert.equal(text.replace("2.0.0", "1.0.0"), ours);
});

test("attribute values merge too", () => {
  const engine = createXmlEngine();
  const base = '<project sdk="net6.0"><name>a</name></project>';
  const doc = engine.analyze(
    base,
    '<project sdk="net7.0"><name>a</name></project>',
    '<project sdk="net6.0"><name>b</name></project>',
  );
  assert.equal(doc.conflictCount, 0);
  const text = engine.serialize(doc);
  assert.match(text, /sdk="net7\.0"/);
  assert.match(text, /<name>b<\/name>/);
});

test("a conflicting attribute can be resolved", () => {
  const engine = createXmlEngine();
  const doc = engine.analyze(
    '<a v="1"/>',
    '<a v="2"/>',
    '<a v="3"/>',
  );
  assert.equal(doc.conflictCount, 1);
  doc.root[0].resolution = { kind: "side", side: "theirs" };
  assert.match(engine.serialize(doc), /v="3"/);
});

test("special characters are escaped when written back", () => {
  const engine = createXmlEngine();
  const doc = engine.analyze("<a><v>x</v></a>", "<a><v>x</v></a>", "<a><v>y</v></a>");
  doc.root[0].resolution = { kind: "custom", text: "a < b & c" };
  const text = engine.serialize(doc);
  assert.match(text, /<v>a &lt; b &amp; c<\/v>/);
});

test("surrounding whitespace in a value is kept", () => {
  const engine = createXmlEngine();
  const ours = "<a>\n  <v>\n    1.0\n  </v>\n</a>";
  const doc = engine.analyze(ours, ours, "<a>\n  <v>\n    2.0\n  </v>\n</a>");
  assert.match(engine.serialize(doc), /<v>\n {4}2\.0\n {2}<\/v>/);
});

test("mixed content falls back rather than corrupting the document", () => {
  const engine = createXmlEngine();
  const mixed = "<p>some <b>bold</b> text</p>";
  assert.throws(() => engine.analyze(mixed, mixed, mixed), UnsupportedInput);
});

test("malformed XML falls back", () => {
  const engine = createXmlEngine();
  assert.throws(() => engine.analyze("<a/>", "<a><unclosed></a>", "<a/>"), UnsupportedInput);
});

test("an element only one branch has is reported rather than written wrong", () => {
  const engine = new XmlMergeEngine();
  const ours = "<deps>\n  <a>1</a>\n</deps>";
  const doc = engine.analyze(ours, ours, "<deps>\n  <a>1</a>\n  <b>2</b>\n</deps>");

  // Adding an element means writing structure, which this engine does not do.
  assert.deepEqual(engine.unsupportedChanges(doc), ["deps.b"]);
  // and the output is left alone rather than mangled
  assert.equal(engine.serialize(doc), ours);
});

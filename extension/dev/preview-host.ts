/**
 * Simulates the extension host for the development harness.
 *
 * It runs the *real* merge engine in the browser and implements the same
 * message protocol as `ConflictEditorProvider`, so the harness exercises the
 * genuine engine-to-UI round trip rather than a mock.
 */

import { createEngine } from "../src/merge/index";
import type { MergeFormat } from "../src/merge/types";
import { countConflicts, type MergeNode, walk } from "../src/merge/types";
import type { HostMessage, WebviewMessage } from "../src/ui/messages";

const FIXTURES = {
  json: {
    path: "package.json",
    base: JSON.stringify(
      {
        name: "acme-web",
        version: "2.3.0",
        scripts: { build: "vite build", test: "vitest" },
        dependencies: { react: "18.0.0", lodash: "4.17.0", zustand: "4.4.0" },
        engines: { node: ">=18" },
      },
      null,
      2,
    ) + "\n",
    ours:
      JSON.stringify(
        {
          name: "acme-web",
          version: "2.4.0",
          scripts: { build: "vite build", test: "vitest", lint: "eslint ." },
          dependencies: { react: "18.2.0", lodash: "4.17.0", vite: "5.0.0" },
          engines: { node: ">=18" },
        },
        null,
        2,
      ) + "\n",
    theirs:
      JSON.stringify(
        {
          name: "acme-web",
          version: "3.0.0",
          scripts: { build: "vite build --mode prod", test: "vitest" },
          dependencies: { react: "19.0.0", lodash: "4.17.21", zod: "3.22.0" },
          engines: { node: ">=20" },
        },
        null,
        2,
      ) + "\n",
  },
  lines: {
    path: ".gitignore",
    base: "node_modules/\n*.log\n",
    ours: "node_modules/\n*.log\ndist/\ncoverage/\n",
    theirs: "node_modules/\n.next/\n*.log.bak\n",
  },
  yaml: {
    path: ".github/workflows/ci.yml",
    base: "name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-20.04\n    node: 18\n",
    ours:
      "# continuous integration\nname: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-22.04\n    node: 18\n    cache: npm\n",
    theirs:
      "name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    node: 20\n",
  },
  lockfile: {
    path: "package-lock.json",
    base: JSON.stringify({ name: "acme-web", version: "2.3.0", packages: { "": {} } }),
    ours: JSON.stringify({
      name: "acme-web",
      version: "2.4.0",
      packages: { "": {}, "node_modules/vite": {}, "node_modules/react": {} },
    }),
    theirs: JSON.stringify({
      name: "acme-web",
      version: "3.0.0",
      packages: { "": {}, "node_modules/zod": {} },
    }),
  },
  arrays: {
    path: ".github/workflows/ci.yml → as JSON",
    base: JSON.stringify({
      include: ["src"],
      dependencies: { react: "18.0.0", vite: "5.0.0" },
      steps: [{ uses: "checkout", ref: "main" }],
    }),
    ours: JSON.stringify(
      {
        include: ["src", "tests"],
        dependencies: { react: "18.2.0", vite: "5.4.0" },
        steps: [
          { uses: "checkout", ref: "develop" },
          { uses: "setup-node", node: "20" },
        ],
      },
      null,
      2,
    ),
    theirs: JSON.stringify({
      include: ["src", "scripts"],
      dependencies: { react: "19.0.0", vite: "5.2.0" },
      steps: [{ uses: "checkout", ref: "release" }, { uses: "cache" }],
    }),
  },
  diff: {
    path: "tsconfig.json",
    base: JSON.stringify({
      compilerOptions: { target: "ES2020", strict: true, lib: ["dom"] },
      settings: { retries: 1, timeout: 30 },
      keywords: ["cli", "cli", "merge"],
    }),
    ours: JSON.stringify(
      {
        compilerOptions: { target: "ES2022", strict: true, lib: ["dom", "es2022"] },
        settings: { retries: 2, timeout: 60, parallel: true },
        keywords: ["cli", "cli", "merge", "git", "json"],
      },
      null,
      2,
    ),
    theirs: JSON.stringify({
      compilerOptions: { target: "ESNext", strict: false, lib: ["dom", "esnext"] },
      settings: { retries: 5, timeout: 90 },
      keywords: ["cli", "cli", "merge", "yaml"],
    }),
  },
} as const;

type FixtureName = keyof typeof FIXTURES;

const which = (new URLSearchParams(location.search).get("fixture") ??
  "json") as FixtureName;
const fixture = FIXTURES[which] ?? FIXTURES.json;
/** Fixture names are not format names: `arrays` is a JSON document too. */
const FORMATS: Record<FixtureName, MergeFormat> = {
  json: "json",
  lines: "lines",
  yaml: "yaml",
  lockfile: "lockfile",
  arrays: "json",
  diff: "json",
};
const engine = createEngine(FORMATS[which] ?? "json");

const doc = engine.analyze(fixture.base, fixture.ours, fixture.theirs);

function send(message: HostMessage): void {
  window.postMessage(message, "*");
}

function findNode(id: string): MergeNode | undefined {
  for (const node of walk(doc.root)) {
    if (node.id === id) {
      return node;
    }
  }
  return undefined;
}

function pushState(): void {
  Object.assign(doc, countConflicts(doc.root));
  send({
    type: "counts",
    conflictCount: doc.conflictCount,
    unresolvedCount: doc.unresolvedCount,
  });
  send({ type: "preview", text: engine.serialize(doc) });
}

// The webview posts to this hook (installed by preview.html).
(window as unknown as { __onMessage?: (m: WebviewMessage) => void }).__onMessage = (
  message,
) => {
  switch (message.type) {
    case "ready":
      break;
    case "setResolution": {
      const node = findNode(message.nodeId);
      if (node) {
        node.resolution = message.resolution;
      }
      pushState();
      break;
    }
    case "setAll": {
      for (const node of walk(doc.root)) {
        if (!node.children && node.status === "conflict") {
          node.resolution = { kind: "side", side: message.side };
        }
      }
      send({ type: "loaded", path: fixture.path, format: doc.format, doc, manualEdits });
      pushState();
      break;
    }
    case "apply":
      send({ type: "applied", staged: message.stage });
      break;
    case "openTextEditor":
      break;
  }
};

/** `?manualEdits=1` previews the warning shown for a hand-edited file. */
const manualEdits = new URLSearchParams(location.search).get("manualEdits") === "1";

send({ type: "loaded", path: fixture.path, format: doc.format, doc, manualEdits });
send({ type: "preview", text: engine.serialize(doc) });

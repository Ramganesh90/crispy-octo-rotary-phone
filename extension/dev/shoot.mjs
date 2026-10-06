/**
 * Drives the resolver harness in Chromium: asserts the UI behaves, then
 * captures screenshots. Run with `node dev/shoot.mjs [outDir]`.
 *
 * This is the closest check available without launching VS Code — it runs the
 * real webview bundle against the real merge engine.
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Playwright is a development-only tool and may be installed globally rather
 * than in this package, so resolve it either way instead of assuming.
 */
async function loadPlaywright() {
  const candidates = [
    "playwright",
    "/opt/node-tools/node_modules/playwright/index.js",
  ];
  for (const candidate of candidates) {
    try {
      const loaded = await import(candidate);
      // A CommonJS build arrives wrapped in `default`.
      return loaded.chromium ? loaded : loaded.default;
    } catch {
      // try the next one
    }
  }
  throw new Error(
    "playwright not found. Install it with `npm install --no-save playwright`.",
  );
}

const { chromium } = await loadPlaywright();

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, "..", "..", "docs", "images"));
mkdirSync(outDir, { recursive: true });

const pageUrl = (fixture, theme) =>
  `file://${join(here, "preview.html")}?fixture=${fixture}#${theme}`;

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(name);
  }
}

const browser = await chromium.launch();

async function open(fixture, theme, height = 760) {
  const page = await browser.newPage({ viewport: { width: 1020, height } });
  page.on("pageerror", (error) => {
    failures.push(`page error: ${error.message}`);
    console.log(`  FAIL page error: ${error.message}`);
  });
  await page.goto(pageUrl(fixture, theme));
  await page.evaluate((t) => document.body.setAttribute("data-theme", t), theme);
  await page.waitForSelector(".toolbar", { timeout: 5000 });
  return page;
}

// ---------------------------------------------------------------- json fixture

console.log("json fixture:");
let page = await open("json", "dark");

const badge = await page.textContent(".toolbar .badge");
check("conflict badge is shown", /conflict/.test(badge ?? ""), badge ?? "");

const conflictRows = await page.locator(".row.conflict").count();
check("every conflict has a row", conflictRows > 0, `rows=${conflictRows}`);

const choicesPerConflict = await page.locator(".row.conflict .choice").count();
check(
  "each conflict offers base/ours/theirs/edit",
  choicesPerConflict === conflictRows * 4,
  `choices=${choicesPerConflict} rows=${conflictRows}`,
);

const previewBefore = (await page.textContent(".preview pre")) ?? "";
check("preview shows the merged document", previewBefore.includes('"name"'), "");
check(
  "unresolved conflicts keep ours in the preview",
  previewBefore.includes('"2.4.0"'),
  "",
);
check("clean incoming changes are already applied", previewBefore.includes('"zod"'), "");

const applyDisabled = await page.locator(".footer button.primary").isDisabled();
check("apply is blocked while conflicts are open", applyDisabled);

await page.screenshot({ path: join(outDir, "resolver-dark.png") });

// Choosing a side must update the preview and re-enable apply.
await page.locator(".row.conflict").first().locator(".choice").nth(1).click();
await page.waitForTimeout(100);
const pressed = await page.locator('.row.conflict .choice[aria-pressed="true"]').count();
check("the chosen side is marked pressed", pressed >= 1, `pressed=${pressed}`);

await page.locator(".toolbar button", { hasText: "All theirs" }).click();
await page.waitForTimeout(150);
const previewAfter = (await page.textContent(".preview pre")) ?? "";
check(
  "All theirs rewrites the preview to their values",
  previewAfter.includes('"3.0.0"') && previewAfter.includes('"19.0.0"'),
  "",
);
const nowEnabled = await page.locator(".footer button.primary").isEnabled();
check("apply is enabled once nothing is unresolved", nowEnabled);
check(
  "status line reports all conflicts resolved",
  ((await page.textContent(".footer .status")) ?? "").includes("resolved"),
);
await page.screenshot({ path: join(outDir, "resolver-resolved.png") });

// Keyboard: j/k move, 2 picks ours.
await page.keyboard.press("j");
await page.keyboard.press("2");
await page.waitForTimeout(100);
check(
  "keyboard selection follows the cursor",
  (await page.locator(".row.current").count()) === 1,
);

// Inline custom value.
await page.keyboard.press("e");
await page.waitForSelector(".custom-editor input");
await page.fill(".custom-editor input", '"9.9.9"');
await page.keyboard.press("Enter");
await page.waitForTimeout(150);
check(
  "a typed value reaches the merged output",
  ((await page.textContent(".preview pre")) ?? "").includes("9.9.9"),
);

// Conflicts-only filter.
await page.locator(".toolbar input[type=checkbox]").check();
await page.waitForTimeout(100);
const filteredRows = await page.locator(".tree .row").count();
const allRows = conflictRows;
check(
  "conflicts-only hides the clean rows",
  filteredRows <= allRows * 2 && filteredRows > 0,
  `filtered=${filteredRows}`,
);
await page.close();

// Light theme, for contrast checking.
page = await open("json", "light");
await page.screenshot({ path: join(outDir, "resolver-light.png") });
await page.close();

// --------------------------------------------------------------- lines fixture

console.log("lines fixture:");
page = await open("lines", "dark");
const linesBadge = (await page.textContent(".toolbar .badge")) ?? "";
check("a line-set file reports no conflicts", linesBadge.includes("cleanly"), linesBadge);
const linesPreview = (await page.textContent(".preview pre")) ?? "";
check(
  "additions from both branches are kept",
  linesPreview.includes("dist/") && linesPreview.includes(".next/"),
);
check(
  "a line the incoming branch removed is dropped",
  !linesPreview.split("\n").includes("*.log"),
  JSON.stringify(linesPreview),
);
check(
  "apply is available immediately for a clean merge",
  await page.locator(".footer button.primary").isEnabled(),
);
await page.screenshot({ path: join(outDir, "resolver-lines.png") });
await page.close();

// ---------------------------------------------------------------- yaml fixture

console.log("yaml fixture:");
page = await open("yaml", "dark");
const yamlBadge = (await page.textContent(".toolbar .badge")) ?? "";
check("yaml conflicts are reported", /conflict/.test(yamlBadge), yamlBadge);
const yamlPreview = (await page.textContent(".preview pre")) ?? "";
check("comments survive the yaml merge", yamlPreview.includes("# continuous integration"));
check("our clean addition is kept", yamlPreview.includes("cache: npm"));
check("their clean change is applied", /node: 20/.test(yamlPreview), yamlPreview);
await page.screenshot({ path: join(outDir, "resolver-yaml.png") });
await page.close();

// ------------------------------------------------------------ lockfile fixture

console.log("lockfile fixture:");
page = await open("lockfile", "dark");
check("a lockfile gets a card, not a tree", (await page.locator(".card").count()) === 1);
check(
  "the card offers keep-ours and keep-theirs",
  (await page.locator(".card .choice").count()) === 2,
);
check(
  "the card summarises each side",
  ((await page.textContent(".card")) ?? "").includes("3 packages"),
  (await page.textContent(".card")) ?? "",
);
check(
  "bulk actions are hidden for a single-decision lockfile",
  (await page.locator(".toolbar button").count()) === 0,
);
check(
  "the keyboard hint is hidden for a lockfile",
  (await page.locator(".hint").count()) === 0,
);
check(
  "regenerate is offered",
  (await page.locator(".footer button", { hasText: "Regenerate" }).count()) === 1,
);
check(
  "apply is blocked until a side is kept",
  await page.locator(".footer button.primary").isDisabled(),
);
await page.locator(".card .choice").nth(1).click();
await page.waitForTimeout(100);
check(
  "keeping a side unblocks apply",
  await page.locator(".footer button.primary").isEnabled(),
);
check(
  "the preview shows the kept side verbatim",
  ((await page.textContent(".preview pre")) ?? "").includes('"3.0.0"'),
);
await page.screenshot({ path: join(outDir, "resolver-lockfile.png") });
await page.close();

// -------------------------------------------------------------- arrays fixture

console.log("arrays fixture:");
page = await open("arrays", "dark");
check(
  "a scalar array merges as a list instead of conflicting",
  ((await page.textContent(".tree")) ?? "").includes("merged as a list"),
);
const arraysPreview = (await page.textContent(".preview pre")) ?? "";
check(
  "both branches' list additions are kept",
  arraysPreview.includes('"tests"') && arraysPreview.includes('"scripts"'),
);
check(
  "records are matched by their identity field",
  ((await page.textContent(".tree")) ?? "").includes("matched up by"),
);
check(
  "only the field both branches changed conflicts",
  (await page.locator(".row.conflict").count()) === 3,
  `rows=${await page.locator(".row.conflict").count()}`,
);
check(
  "the newer version is marked recommended",
  (await page.locator(".choice.suggested .rec").count()) === 2,
);
check(
  "accept-recommended is offered with a count",
  ((await page.textContent(".toolbar")) ?? "").includes("Accept 2 recommended"),
);
await page.screenshot({ path: join(outDir, "resolver-arrays.png") });

await page.locator(".toolbar button", { hasText: "Accept" }).click();
await page.waitForTimeout(150);
check(
  "accepting recommendations resolves exactly those conflicts",
  ((await page.textContent(".footer .status")) ?? "").includes("1 conflict"),
  (await page.textContent(".footer .status")) ?? "",
);
check(
  "accepted recommendations reach the merged output",
  ((await page.textContent(".preview pre")) ?? "").includes('"19.0.0"'),
);

// The whole-subtree override must beat the entry-by-entry merge.
await page.locator(".row.container", { hasText: "include" }).first().hover();
await page.locator(".row.container", { hasText: "include" }).first()
  .locator(".whole button", { hasText: "theirs" }).click();
await page.waitForTimeout(150);
const overridden = (await page.textContent(".preview pre")) ?? "";
check(
  "keeping a subtree whole overrides the merge",
  overridden.includes('"scripts"') && !overridden.includes('"tests"'),
);
await page.close();

// ---------------------------------------------------- hand-edited file warning

console.log("hand-edited file:");
page = await browser.newPage({ viewport: { width: 1000, height: 430 } });
await page.goto(`file://${join(here, "preview.html")}?fixture=json&manualEdits=1`);
await page.waitForSelector(".banner");
check(
  "a hand-edited file is called out before anything is lost",
  ((await page.textContent(".banner")) ?? "").includes("edited since the merge"),
);
check(
  "the banner offers the text editor as the way out",
  (await page.locator(".banner button").count()) === 1,
);
await page.close();

// ------------------------------------------------------- search, subtree, diff

console.log("ui depth:");
page = await open("diff", "dark", 760);

const beforeFilter = await page.locator(".tree .row").count();
await page.fill(".toolbar .search", "retr");
await page.waitForTimeout(150);
const afterFilter = await page.locator(".tree .row").count();
check(
  "filtering by key narrows the tree",
  afterFilter < beforeFilter && afterFilter > 0,
  `${beforeFilter} -> ${afterFilter}`,
);
check(
  "the filter keeps the matching key visible",
  ((await page.textContent(".tree")) ?? "").includes("retries"),
);
await page.fill(".toolbar .search", "nothingmatchesthis");
await page.waitForTimeout(150);
check(
  "a filter matching nothing says so rather than showing an empty pane",
  (await page.locator(".tree .message").count()) === 1,
);
await page.fill(".toolbar .search", "");
await page.waitForTimeout(150);

const settings = page.locator(".row.container", { hasText: "settings" }).first();
await settings.hover();
check(
  "a subtree with several conflicts offers to resolve just those",
  (await settings.locator(".whole button").allTextContents()).some((t) =>
    t.includes("below"),
  ),
);
await settings.locator(".whole button", { hasText: "below: theirs" }).click();
await page.waitForTimeout(150);
const afterSubtree = (await page.textContent(".preview pre")) ?? "";
check(
  "resolving a subtree applies to its conflicts only",
  afterSubtree.includes('"retries": 5') && afterSubtree.includes('"parallel": true'),
  "",
);

// A conflict whose value is a whole array gets a real diff, not "{3 items}".
for (let i = 0; i < 4; i++) {
  await page.keyboard.press("j");
}
await page.waitForTimeout(200);
check(
  "a structured conflict shows both sides side by side",
  (await page.locator(".diff-col").count()) === 2,
);
check(
  "lines on only one side are marked",
  (await page.locator(".diff-line.only-ours, .diff-line.only-theirs").count()) > 0,
);
const diffBox = await page.locator(".diff").boundingBox();
check(
  "the diff is bounded rather than clipped by the pane",
  diffBox !== null && diffBox.height > 60 && diffBox.height < 420,
  `height=${Math.round(diffBox?.height ?? 0)}`,
);
await page.screenshot({ path: join(outDir, "resolver-diff.png") });
await page.close();

// ------------------------------------------------------------- js/jsx fixture

console.log("js fixture:");
page = await open("js", "dark", 720);
check(
  "declarations each branch added merge with nothing to decide",
  ((await page.textContent(".tree")) ?? "").includes("Sidebar") &&
    ((await page.textContent(".tree")) ?? "").includes("Header"),
);
const jsPreview = (await page.textContent(".preview pre")) ?? "";
check(
  "imports from both branches end up together",
  jsPreview.includes('from "react"') && jsPreview.includes('from "./theme"'),
);
check(
  "imports are not separated by a stray blank line",
  !/from "react";\n\n+import/.test(jsPreview),
  JSON.stringify(jsPreview.slice(0, 120)),
);
check(
  "a declaration both branches changed is a conflict",
  ((await page.textContent(".toolbar .badge")) ?? "").includes("2 conflict"),
);
check(
  "a code conflict shows the two versions as code, side by side",
  (await page.locator(".diff-col").count()) === 2,
);
check(
  "code is not rendered as an escaped JSON string",
  !((await page.textContent(".diff")) ?? "").includes("\\n"),
);
check(
  "the differing lines are the ones marked",
  (await page.locator(".diff-line.only-ours, .diff-line.only-theirs").count()) >= 2,
);
await page.screenshot({ path: join(outDir, "resolver-js.png") });
await page.close();

await browser.close();

console.log(
  failures.length === 0
    ? `\nAll harness checks passed. Screenshots in ${outDir}`
    : `\n${failures.length} harness check(s) failed.`,
);
process.exit(failures.length === 0 ? 0 : 1);

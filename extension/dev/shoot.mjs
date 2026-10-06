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

import { chromium } from "playwright";

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

async function open(fixture, theme) {
  const page = await browser.newPage({ viewport: { width: 980, height: 760 } });
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

await browser.close();

console.log(
  failures.length === 0
    ? `\nAll harness checks passed. Screenshots in ${outDir}`
    : `\n${failures.length} harness check(s) failed.`,
);
process.exit(failures.length === 0 ? 0 : 1);

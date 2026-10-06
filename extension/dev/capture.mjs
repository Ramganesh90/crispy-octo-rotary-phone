/**
 * Captures the conflict-handling walkthrough: the states a developer actually
 * passes through, in order, from an unresolved conflict to an applied merge.
 *
 * Runs the real webview bundle against the real merge engine in Chromium.
 * `node dev/capture.mjs [outDir]`
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, "..", "..", "docs", "images", "walkthrough"));
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const shots = [];

async function open(fixture, theme = "dark", height = 700) {
  const page = await browser.newPage({ viewport: { width: 1000, height } });
  page.on("pageerror", (e) => console.log(`  page error: ${e.message}`));
  await page.goto(`file://${join(here, "preview.html")}?fixture=${fixture}`);
  await page.evaluate((t) => document.body.setAttribute("data-theme", t), theme);
  await page.waitForSelector(".toolbar");
  await page.waitForTimeout(80);
  return page;
}

async function shot(page, name, caption) {
  const path = join(outDir, `${name}.png`);
  await page.screenshot({ path });
  shots.push({ name, caption });
  console.log(`  ${name}.png — ${caption}`);
}

// 1. The conflict as it arrives.
let page = await open("json");
await shot(
  page,
  "01-conflicts-found",
  "Two keys conflict; everything else is already merged. Apply is disabled.",
);

// 2. Filtered to just the decisions.
await page.locator(".toolbar input[type=checkbox]").check();
await page.waitForTimeout(120);
await shot(page, "02-conflicts-only", "Conflicts-only hides every key that merged cleanly.");
await page.locator(".toolbar input[type=checkbox]").uncheck();
await page.waitForTimeout(120);

// 3. One decision made, preview updates live.
await page.locator(".row.conflict").first().locator(".choice").nth(2).click();
await page.waitForTimeout(150);
await shot(
  page,
  "03-one-resolved",
  "Picking Theirs for `version` updates the preview; one conflict left.",
);

// 4. Typing a value that is on neither side.
await page.locator(".row.conflict").nth(1).locator(".choice").nth(3).click();
await page.waitForSelector(".custom-editor input");
await page.fill(".custom-editor input", '"18.3.1"');
await page.waitForTimeout(80);
await shot(
  page,
  "04-custom-value",
  "A third option: type a value neither branch has.",
);
await page.keyboard.press("Enter");
await page.waitForTimeout(150);

// 5. Everything decided.
await shot(
  page,
  "05-resolved",
  "All conflicts decided, so Apply unlocks. The preview is the exact file to be written.",
);
await page.close();

// 6. Light theme.
page = await open("json", "light");
await shot(page, "06-light-theme", "The same view in a light theme.");
await page.close();

// 7. A file that needs no decisions.
page = await open("lines", "dark", 560);
await shot(
  page,
  "07-clean-merge",
  "A .gitignore: both branches' additions kept, their deletion applied, nothing to decide.",
);
await page.close();

// 8. YAML.
page = await open("yaml", "dark", 640);
await shot(
  page,
  "08-yaml",
  "YAML, with comments preserved through the merge.",
);
await page.close();

// 9. Lockfile.
page = await open("lockfile", "dark", 560);
await shot(
  page,
  "09-lockfile",
  "A lockfile is refused a key-by-key merge and offered as one honest choice.",
);
await page.close();

// 10. Unsupported file falling back.
page = await browser.newPage({ viewport: { width: 1000, height: 320 } });
await page.goto(`file://${join(here, "preview.html")}?fixture=json`);
await page.evaluate(() => {
  window.postMessage(
    {
      type: "error",
      message:
        "Cannot resolve this file key by key: src/app.ts is not a structured format.",
      canFallBackToText: true,
    },
    "*",
  );
});
await page.waitForSelector(".message");
await shot(
  page,
  "10-fallback",
  "An unsupported or unparseable file says so and hands off to the text editor.",
);
await page.close();

await browser.close();
console.log(`\n${shots.length} screenshots in ${outDir}`);

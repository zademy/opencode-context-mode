#!/usr/bin/env node
/**
 * render-hero — docs/images/opencode-hero.html → opencode-hero.png
 *
 * The README hero is generated, not hand-edited: change the HTML, re-run this
 * script, commit both. Canvas is 1280x720 CSS px; deviceScaleFactor 1.25
 * lands the PNG at 1600x900 (2x density for HiDPI rendering on GitHub).
 *
 * Needs playwright-core + a chromium build; neither is a repo dependency:
 *   npm i --no-save playwright-core && npx playwright install chromium
 *   node scripts/render-hero.mjs
 */
import { chromium } from "playwright-core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(REPO_ROOT, "docs/images/opencode-hero.html");
const OUT = resolve(REPO_ROOT, "docs/images/opencode-hero.png");

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1.25,
});
await page.goto("file://" + SRC, { waitUntil: "load" });
await page.waitForTimeout(500);
await page.screenshot({ path: OUT });
await browser.close();
console.log("rendered " + OUT);

import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";

// #406 S1 / ADR-159 §3: the mobile chrome slice, pinned at the ADR's reference viewports —
// phone 390×844 (below md) and tablet 768×1024 (at md, i.e. desktop chrome). The drawer is
// ephemeral (never touches the desktop wks.sidebarCollapsed key), closes on scrim / Esc /
// navigation; the header compresses (icon search, member toggles fold into the account menu);
// right-zone panels render as full-width sheets.

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };

test("#406 S1: phone — drawer sidebar (ephemeral, scrim/Esc close), compressed header", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: PHONE })).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content", { timeout: 15000 });
  await sleep(500);

  // no docked sidebar; the toggle exists
  await expect(page.getByTestId("mobile-drawer")).toHaveCount(0);
  await expect(page.locator("aside[class*=grid-area]")).toHaveCount(0);
  const before = await page.evaluate(() => localStorage.getItem("wks.sidebarCollapsed"));

  // toggle opens the drawer over a scrim
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("mobile-drawer")).toBeVisible();
  await expect(page.getByTestId("drawer-scrim")).toBeVisible();
  // the drawer never writes the desktop preference
  const after = await page.evaluate(() => localStorage.getItem("wks.sidebarCollapsed"));
  expect(after).toBe(before);

  // scrim closes
  await page.getByTestId("drawer-scrim").click({ position: { x: 380, y: 400 } });
  await expect(page.getByTestId("mobile-drawer")).toHaveCount(0);

  // Esc closes
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("mobile-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("mobile-drawer")).toHaveCount(0);

  // header compression: icon-only search trigger still opens the modal; the standalone member
  // toggles are hidden and the account menu carries theme/language rows instead
  await expect(page.getByTestId("search-trigger")).toBeVisible();
  await page.getByTestId("search-trigger").click();
  await expect(page.getByTestId("search-input")).toBeVisible({ timeout: 8000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("theme-toggle")).toBeHidden();
  await page.getByTestId("user-menu").click();
  await expect(page.getByTestId("user-menu-theme")).toBeVisible();
  await expect(page.getByTestId("user-menu-language")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("#406 S1: phone — the comments panel renders as a full-width sheet", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: PHONE })).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content", { timeout: 15000 });
  await sleep(500);
  // phone widths render the PageControlsMobile cluster (one ⋯ with m-* items)
  await page.getByTestId("page-controls-mobile").click();
  await page.getByTestId("m-comments-toggle").click();
  const panel = page.getByTestId("comments-panel");
  await expect(panel).toBeVisible({ timeout: 10000 });
  const w = await panel.evaluate((el) => el.getBoundingClientRect().width);
  expect(w, "the sheet spans the full viewport width").toBeGreaterThanOrEqual(PHONE.width - 2);
  await page.getByTestId("comments-close").click();
  await expect(panel).toHaveCount(0);
});

test("#406 S1: tablet (md) keeps the desktop chrome — docked sidebar, 320px panel", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: TABLET })).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content", { timeout: 15000 });
  await sleep(500);
  // the docked sidebar column renders (tree visible without any toggle) and no drawer exists
  await expect(page.getByTestId("sidebar-home")).toBeVisible();
  await expect(page.getByTestId("mobile-drawer")).toHaveCount(0);
  // the search trigger is the field-shaped desktop variant (has visible text)
  const trigTxt = (await page.getByTestId("search-trigger").innerText()).trim();
  expect(trigTxt.length, "desktop search trigger keeps its label").toBeGreaterThan(0);
  // right panel is the docked 320px aside
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("comments-toggle").click();
  const panel = page.getByTestId("comments-panel");
  await expect(panel).toBeVisible({ timeout: 10000 });
  const w = await panel.evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(w), "docked aside width").toBe(320);
});

// ---- S2 (read surfaces): the T1/T2 phone reading invariants (ADR-159 §1/§3) ----
// Wide content (tables, code, long URLs) must scroll INSIDE its own container — the page body never
// scrolls horizontally — and the public reader keeps a readable base font on a phone.
import { enterEdit, openScratch, setPublicSurface } from "../helpers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WIDE_CONTENT =
  "# Wide\n\nbody paragraph\n\n| colA | colB | colC | colD | colE | colF |\n| --- | --- | --- | --- | --- | --- |\n| a very long cell value here | bbbb | cccc | dddd | eeee | ffff |\n\n```js\nconst aVeryLongLineOfCodeThatWouldOverflowTheNarrowViewportWidthForSureYesReally = 1234567890;\n```\n\ntail\n";

async function docOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => ({
    over: document.documentElement.scrollWidth > window.innerWidth + 1,
    innerScrollers: [...document.querySelectorAll("[data-pane=preview] *, [data-testid=public-body] *")]
      .filter((el) => el.scrollWidth > el.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(el).overflowX)).length,
  }));
}

test("#406 S2: phone member READ surface — wide content scrolls in-container, never the page", async ({ browser }) => {
  const desktop = await (await browser.newContext()).newPage();
  const id = await openScratch(desktop, "mobile-read-406");
  await enterEdit(desktop);
  await desktop.click("[data-pane=preview] .cm-content");
  await desktop.keyboard.insertText(WIDE_CONTENT);
  await sleep(400);
  await desktop.getByTestId("publish-page").click();
  await sleep(800);

  const phone = await (await browser.newContext({ viewport: PHONE })).newPage();
  await phone.goto(`/p/${id}`);
  await phone.waitForSelector("[data-pane=preview] .cm-content", { timeout: 15000 });
  await sleep(800);
  const m = await docOverflow(phone);
  expect(m.over, "the page never scrolls horizontally").toBe(false);
  // the CM read surface WRAPS long code lines (lineWrapping) and the table scrolls in its wrap —
  // either strategy is fine; the invariant is that nothing widens the page itself.
});

test("#406 S2: phone public reader — no horizontal overflow, readable base font", async ({ browser }) => {
  const repoEnv = readFileSync(fileURLToPath(new URL("../../../.env.e2e.local", import.meta.url)), "utf8");
  const STORE = /OPENFGA_STORE_ID=(.+)/.exec(repoEnv)![1]!.trim();
  const MODEL = /OPENFGA_MODEL_ID=(.+)/.exec(repoEnv)![1]!.trim();
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, "mobile-pub-406");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText(WIDE_CONTENT);
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  const res = await fetch(`http://localhost:8090/stores/${STORE}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ writes: { tuple_keys: [{ user: "user:*", relation: "view_base", object: `page:${id}` }] }, authorization_model_id: MODEL }),
  });
  expect(res.ok).toBe(true);
  await setPublicSurface(authed, true);

  const anon = await (await browser.newContext({ viewport: PHONE })).newPage();
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByTestId("public-title")).toBeVisible({ timeout: 15000 });
  await sleep(500);
  const m = await docOverflow(anon);
  expect(m.over, "the public reader never scrolls horizontally").toBe(false);
  const font = await anon.getByTestId("public-body").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(font, "readable base font on a phone").toBeGreaterThanOrEqual(15);
});

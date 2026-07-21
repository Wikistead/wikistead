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

// The table is deliberately WIDER than a phone even at its minimum content width — eight columns of
// unbreakable tokens. A table of short, wrappable cells fits 390px by wrapping, which is exactly the
// case the old pin measured and the reason it never noticed the squeeze.
const WIDE_CONTENT =
  "# Wide\n\nbody paragraph\n\n| colA | colB | colC | colD | colE | colF | colG | colH |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| aaaaaaaaaaaaaaa | bbbbbbbbbbbbbbb | ccccccccccccccc | ddddddddddddddd | eeeeeeeeeeeeeee | fffffffffffffff | ggggggggggggggg | hhhhhhhhhhhhhhh |\n\n```js\nconst aVeryLongLineOfCodeThatWouldOverflowTheNarrowViewportWidthForSureYesReally = 1234567890;\n```\n\ntail\n";

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
  // → "the page doesn't scroll" was too weak twice over. First it passed while the table
  // was squeezed into the viewport; then it passed while the fix let the EDITOR scroll sideways —
  // body text and all — because the only thing asserted about the scroller was that one existed
  // somewhere above the table. What must hold is narrower: nothing but the table's own box scrolls.
  await assertOnlyTableScrolls(phone, "member read");
});

// The horizontal-scroll contract, measured the same way on every surface: no page-level container
// scrolls sideways, exactly one box does, it is the table's own, and the far edge is reachable inside it.
async function assertOnlyTableScrolls(page: import("@playwright/test").Page, surface: string) {
  const m = await page.evaluate(() => {
    const roots = ["html", "body", "[data-pane=preview] .cm-scroller", "[data-pane=preview] .cm-content", ".wks-prose", "[data-testid=public-body]"];
    const pageLevel = roots.flatMap((sel) => [...document.querySelectorAll(sel)] as HTMLElement[])
      .map((el) => ({ sel: el.tagName + "." + String(el.className).split(" ")[0], over: el.scrollWidth - el.clientWidth }))
      .filter((r) => r.over > 1);
    const scrollers = ([...document.querySelectorAll("[data-pane=preview] *, [data-testid=public-body] *, .wks-prose *")] as HTMLElement[])
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX))
      .map((el) => ({ cls: String(el.className), holdsTable: !!el.querySelector(":scope > table"), w: el.clientWidth }));
    const t = document.querySelector("[data-pane=preview] table, [data-testid=public-body] table, .wks-prose table") as HTMLElement | null;
    return { pageLevel, scrollers, tableW: t?.scrollWidth ?? 0, viewport: window.innerWidth };
  });
  expect(m.pageLevel, `${surface}: no page-level container scrolls sideways`).toEqual([]);
  expect(m.scrollers.length, `${surface}: exactly one horizontal scroller (got ${JSON.stringify(m.scrollers)})`).toBe(1);
  expect(m.scrollers[0]!.holdsTable, `${surface}: and it is the table's own box`).toBe(true);
  expect(m.scrollers[0]!.w, `${surface}: that box is no wider than the viewport`).toBeLessThanOrEqual(m.viewport);
  expect(m.tableW, `${surface}: the table itself keeps its natural width`).toBeGreaterThan(m.viewport);
  // the far edge is reachable by scrolling that box (and only that box)
  const reached = await page.evaluate(() => {
    const box = ([...document.querySelectorAll("[data-pane=preview] *, [data-testid=public-body] *, .wks-prose *")] as HTMLElement[])
      .find((el) => el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX));
    if (!box) return null;
    const before = document.documentElement.scrollLeft;
    box.scrollLeft = box.scrollWidth;
    return { boxScrolled: box.scrollLeft > 0, pageMoved: document.documentElement.scrollLeft !== before };
  });
  expect(reached?.boxScrolled, `${surface}: the table box really scrolls`).toBe(true);
  expect(reached?.pageMoved, `${surface}: and scrolling it never moves the page`).toBe(false);
}

// #406 the TOC toggle and the draft / unpublished badges live in PageStatus, which the member
// view used to render only above md — so on a phone the member surface lost both, while the public
// reader (which renders the same control unconditionally) kept them. Whatever the layout does, the
// member view must not be the one that hides the page's publish state.
test("#406 the member page keeps PageStatus (TOC toggle + badges) on a phone", async ({ browser }) => {
  const desktop = await (await browser.newContext()).newPage();
  const id = await openScratch(desktop, "mobile-status-406");
  await enterEdit(desktop);
  await desktop.click("[data-pane=preview] .cm-content");
  await desktop.keyboard.insertText("# Heading one\n\nbody\n\n## Heading two\n\nmore\n");
  await sleep(500);

  const phone = await (await browser.newContext({ viewport: PHONE })).newPage();
  await phone.goto(`/p/${id}`);
  await phone.waitForSelector("[data-pane=preview] .cm-content", { timeout: 15000 });
  await sleep(800);
  await expect(phone.getByTestId("page-status"), "the status cluster survives the narrow layout").toBeVisible();
  await expect(phone.getByTestId("toc-toggle"), "including the TOC toggle the public reader already showed").toBeVisible();
  // the page was never published, so its draft state must be visible here too
  await expect(phone.getByTestId("draft-badge")).toBeVisible();
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
  // the same contract as the member surface — the reader's own containers stay put and only the
  // table's box scrolls. The public reader renders through the prose path, which had the same defect.
  await assertOnlyTableScrolls(anon, "public reader");
  const font = await anon.getByTestId("public-body").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(font, "readable base font on a phone").toBeGreaterThanOrEqual(15);
});

// ---- S4 (editor light pass, the ruled piece): (pointer: coarse) forces vim OFF ----
// A vim-enabled user's soft-keyboard input breaks under vim, so on a touch device the EFFECTIVE
// keymap is plain CM6 while the stored preference stays untouched (vim returns on a fine pointer).
test("#406 S4: coarse pointer forces vim OFF without touching the stored preference", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem("wks.editorVim", "1")); // vim pref ON
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content", { timeout: 15000 });
  await sleep(600);
  // enter edit via the mobile cluster
  await page.getByTestId("page-controls-mobile").click();
  await page.getByTestId("m-edit-toggle").click();
  await page.waitForSelector("[data-pane=preview] .cm-content[contenteditable=true]", { timeout: 10000 });
  await sleep(600);
  // vim is OFF on the surface: no fat (normal-mode) cursor renders
  await page.click("[data-pane=preview] .cm-content");
  await sleep(300);
  await expect(page.locator(".cm-fat-cursor"), "no vim normal-mode cursor on touch").toHaveCount(0);
  // the mobile menu's vim row is disabled (visible but inert, with the explanation)
  await page.getByTestId("page-controls-mobile").click();
  const vimRow = page.getByTestId("m-vim-toggle");
  await expect(vimRow).toBeVisible();
  await expect(vimRow).toHaveAttribute("data-disabled", "");
  await page.keyboard.press("Escape");
  // the stored preference is untouched — a fine-pointer device would restore vim
  const pref = await page.evaluate(() => localStorage.getItem("wks.editorVim"));
  expect(pref, "the device-local vim preference survives").toBe("1");
});

// ---- S3 (dialog/picker audit): sub-sm gutter + list-only pickers at phone width ----
test("#406 S3: phone dialogs use the 2rem gutter; the search preview pane hides below md", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: PHONE })).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content", { timeout: 15000 });
  await sleep(500);
  await page.getByTestId("search-trigger").click();
  await expect(page.getByTestId("search-input")).toBeVisible({ timeout: 8000 });
  const dlgW = await page.getByTestId("search-input").evaluate((el) => (el.closest("[role=dialog]") as HTMLElement).offsetWidth); // offsetWidth: immune to the zoom-in animation transform
  // sub-sm: 100vw - 2rem (the old 4rem gutter left only 326px on a 390px phone)
  expect(dlgW, "phone dialog width = 100vw - 2rem").toBeGreaterThanOrEqual(PHONE.width - 33);
  await page.getByTestId("search-input").fill("demo");
  await sleep(600);
  await expect(page.getByTestId("search-preview"), "two-pane picker degrades to list-only below md").toBeHidden();
});

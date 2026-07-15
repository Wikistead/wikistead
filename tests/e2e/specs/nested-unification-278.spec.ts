import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #278 / ADR-122 addendum: nested-editor unification anti-tests (the real-DOM half; the shared-factory
// parity half is unit-tested in nested-editor-factory.test.ts).
//  (a) host-only CSS is scoped to the TOP-LEVEL surface via a direct-child chain — the outer .cm-content
//      KEEPS its clearances/reading column while ANY nested .cm-content inherits none of them (the former
//      per-nested cancel rules are retired; clean by construction).
//  item 1: switching tabs while a slot island is open COMMITS and CLOSES the island (it must not stay
//      bound to the old tab while the preview shows the new one).
//  item 6: the layout × brightens on hover (brightness-up affordance, not the darker fill).

const content = (p: any) => p.locator("[data-pane=preview] .cm-content").first().innerText();

test("#278 (a): top-level .cm-content keeps clearances + reading column; the island's inherits none", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "nested-css-scope"); await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\nAAA\n:::\n:::column\nBBB\n:::\n::::\n\nbot\n");
  await sleep(700);
  await page.getByText("bot").click(); await sleep(200);

  // The TOP-LEVEL surface must still get the host clearances (the direct-child chain matches it):
  // bottom floating-controls room (4.5rem = 72px) and the centred reading column (max-width 740px).
  const outer = await page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .lp-editor-host > .cm-editor > .cm-scroller > .cm-content") as HTMLElement;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { paddingBottom: cs.paddingBottom, maxWidth: cs.maxWidth };
  });
  expect(outer, "top-level .cm-content found via the direct-child chain").not.toBeNull();
  expect(outer!.paddingBottom, "outer keeps the floating-controls clearance").toBe("72px");
  expect(outer!.maxWidth, "outer keeps the reading column").toBe("740px");

  // Open the slot island → its nested .cm-content must inherit NEITHER (zero clearances, no column).
  await page.locator("[data-pane=preview] .cm-lp-column").first().click();
  await sleep(400);
  const nested = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=slot-edit-island] .cm-content") as HTMLElement;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, maxWidth: cs.maxWidth };
  });
  expect(nested, "island .cm-content found").not.toBeNull();
  expect(nested!.paddingTop, "no header-band clearance inside the island").toBe("0px");
  expect(nested!.paddingBottom, "no floating-controls clearance inside the island").toBe("0px");
  expect(nested!.maxWidth, "no reading-column measure inside the island").toBe("none");
});

test("#278 (a): the mermaid editUI source pane inherits no host clearance (own 6px padding only)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "nested-css-mermaid"); await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n```\n\nbelow\n");
  await sleep(700);
  await page.getByText("below", { exact: true }).click(); await sleep(200);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").hover(); await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=macro-edit]").first().click({ force: true });
  await sleep(400);
  const pad = await page.evaluate(() => {
    const el = document.querySelector(".cm-lp-mermaid-edit-src .cm-content") as HTMLElement;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom) };
  });
  expect(pad, "mermaid source pane .cm-content found").not.toBeNull();
  // its OWN code-face theme is 6px; the leaked host clearance was 72px bottom + band top.
  expect(pad!.bottom, `pane padding-bottom ${pad!.bottom}px must be its own theme, not the 72px leak`).toBeLessThan(20);
  expect(pad!.top, `pane padding-top ${pad!.top}px must be its own theme, not the band leak`).toBeLessThan(20);
});

// item 1 (island lifecycle): switching tabs while the island is open must COMMIT the island's text and
// CLOSE it — the new tab renders normally (no stale island editing the old tab beside the new preview).
test("#278 item 1: switching tabs commits + closes the open slot island", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const errs: string[] = []; page.on("pageerror", (e) => errs.push(String(e)));
  await openScratch(page, "tab-switch-island"); await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::tabs\n:::tab[One]\nalpha\n:::\n:::tab[Two]\nbeta\n:::\n::::\n\ntail\n");
  await sleep(700);
  await page.getByText("tail", { exact: true }).click(); await sleep(200);

  // open the island in tab One and type into it (no blur yet).
  await page.locator("[data-pane=preview] .cm-lp-tabpanel-active").first().click();
  await sleep(400);
  const island = page.locator("[data-testid=slot-edit-island]");
  await expect(island).toBeVisible();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" EDIT");
  await sleep(150);

  // switch to tab Two → the island must commit and unmount; Two's content renders.
  await page.locator("[data-pane=preview] .cm-lp-tab", { hasText: "Two" }).click();
  await sleep(500);
  await expect(page.locator("[data-testid=slot-edit-island]"), "island closed on tab switch").toHaveCount(0);
  const active = page.locator("[data-pane=preview] .cm-lp-tabpanel-active");
  await expect(active, "the NEW tab renders after the switch").toContainText("beta");

  // the island's text landed in tab One's body (commit, not discard).
  await page.getByTestId("displaymode-source").click();
  await sleep(300);
  const s = await content(page);
  expect(s).toContain("alpha EDIT");
  expect(s).toContain("beta");
  expect(errs, errs.join(" | ")).toHaveLength(0);
});

//point 2 (user ruling, supersedes the"keeps editing" pin): clicking the EDITED tab's
// own header COMMITS the island and opens the inline rename — nothing typed in the island is lost.
test("#278 item 1: clicking the edited tab's own header commits + opens rename", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tab-same-island"); await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::tabs\n:::tab[One]\nalpha\n:::\n:::tab[Two]\nbeta\n:::\n::::\n\ntail\n");
  await sleep(700);
  await page.getByText("tail", { exact: true }).click(); await sleep(200);
  await page.locator("[data-pane=preview] .cm-lp-tabpanel-active").first().click();
  await sleep(400);
  await expect(page.locator("[data-testid=slot-edit-island]")).toBeVisible();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" EDIT");
  await sleep(150);
  await page.locator("[data-pane=preview] .cm-lp-tab", { hasText: "One" }).click();
  await sleep(500);
  await expect(page.locator("[data-testid=slot-edit-island]"), "the island committed + closed").toHaveCount(0);
  await expect(page.getByTestId("tab-rename-input"), "the inline rename opened").toHaveCount(1);
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.getByTestId("displaymode-source").click();
  await sleep(300);
  const s = await page.locator("[data-pane=preview] .cm-content").first().innerText();
  expect(s, "the island edit was committed, not discarded").toContain("alpha EDIT");
});

// item 6: the layout × BRIGHTENS on hover (brightness-up, not the darker danger fill).
test("#278 item 6: the column × brightens on hover", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "remove-hover"); await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\nAAA\n:::\n:::column\nBBB\n:::\n::::\n\nbot\n");
  await sleep(700);
  await page.getByText("bot").click(); await sleep(200);
  const x = page.locator("[data-pane=preview] [data-testid=layout-remove-column]").first();
  await page.locator("[data-pane=preview] .cm-lp-column").first().hover();
  await sleep(200);
  await x.hover();
  await sleep(200);
  const filter = await x.evaluate((el) => getComputedStyle(el).filter);
  expect(filter, `hover filter is ${filter}`).toContain("brightness(1.3)");
});

// Factory parity smoke (b): a nested macro typed INSIDE the island renders there like the outer surface
// (the shared decoration layer at work — previously a hand-mirrored subset could drift).
test("#278 (b): a callout typed inside the island renders as a callout (shared factory)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "island-nested-macro"); await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\nAAA\n:::\n:::column\nBBB\n:::\n::::\n\nbot\n");
  await sleep(700);
  await page.getByText("bot").click(); await sleep(200);
  await page.locator("[data-pane=preview] .cm-lp-column").first().click();
  await sleep(400);
  const island = page.locator("[data-testid=slot-edit-island]");
  await expect(island).toBeVisible();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\n:::note\ninner callout\n:::\nplain");
  await sleep(400);
  // the island renders the callout (the same callout panel class the outer surface uses).
  await expect(island.locator(".cm-lp-callout-panel").first()).toBeVisible();
  await expect(island.locator(".cm-lp-callout-panel-body").first()).toContainText("inner callout");
});

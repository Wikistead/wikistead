import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #174 (review rejection comment 1071): four block-interaction fixes for nested macros, all in WYSIWYG.
// Real Chromium — nested-widget hit-testing / :has hover suppression / re-render tab state can't be
// exercised in happy-dom.

// Point 1: a fence macro (mermaid) NESTED in a tabs/columns container gets the same hover ✎ as a nested
// callout — it was missing because macroFenceAt couldn't resolve a directive-nested fence from the syntax
// tree; a text-scan fallback fixes it.
test("#174-1: a nested mermaid fence has a hover ✎ in WYSIWYG", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openScratch(page, "nested-fence-pencil");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::columns\n:::column\n```mermaid\ngraph TD\nA-->B\n```\n:::\n:::column\nplain\n:::\n::::\n\nbelow\n");
  await sleep(600);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(600);

  const columns = page.locator("[data-pane=preview] [data-testid=macro-columns]").first();
  await expect(columns).toBeVisible();
  // hover the nested mermaid slot (tagged data-mac-name=mermaid) → its own ✎ appears.
  const slot = columns.locator("[data-mac-name=mermaid]").first();
  await expect(slot).toBeVisible();
  await slot.hover();
  await expect(columns.getByTestId("nested-macro-edit").first(), "nested mermaid has a hover ✎").toBeVisible();
  expect(errors, errors.join(" | ")).toHaveLength(0);
});

// Point 3: innermost-wins — the nested slot's ✎ appears on hover, and the CONTAINER never shows a
// competing ✎. Originally this was a hover-suppression rule; since #278 §2a retired the layout
// containers' editUI panel, a columns/tabs container has NO own ✎ at all (slot editing is
// click-to-edit), so the stronger assertion is that it simply doesn't exist.
test("#174-3: hovering a nested slot suppresses the container ✎", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "inner-outer-pencil");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::columns\n:::column\n:::note\nhi\n:::\n:::\n:::column\nplain\n:::\n::::\n\nbelow\n");
  await sleep(500);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(500);

  // The container's own ✎ lives in the widget WRAP (a sibling of the macro-columns element), so scope to the
  // wrap, not to macro-columns.
  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap:has([data-testid=macro-columns])").first();
  const slot = wrap.locator("[data-mac-pos]").first();
  await slot.hover();
  await sleep(150);
  const opacity = (loc: ReturnType<typeof wrap.getByTestId>) => loc.first().evaluate((el) => getComputedStyle(el).opacity);
  // the nested ✎ is shown; the container has NO own ✎ (its editUI panel was retired by #278 §2a),
  // so the inner and outer pencils can never co-occur.
  expect(Number(await opacity(wrap.getByTestId("nested-macro-edit")))).toBeGreaterThan(0);
  await expect(wrap.locator("> .cm-lp-macro-btnrow [data-testid=macro-edit]")).toHaveCount(0);
});

// Point 2: switching to tab 2 then clicking a nested macro inside it must KEEP tab 2 active (the re-render
// used to reset to tab 1).
test("#174-2: a nested click keeps the active tab (no reset to tab 1)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tab-persist");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::tabs\n:::tab[One]\nplain one\n:::\n:::tab[Two]\n:::note\nin two\n:::\n:::\n::::\n\nbelow\n");
  await sleep(600);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(600);

  const tabs = page.locator("[data-pane=preview] [data-testid=macro-tabs]").first();
  await expect(tabs).toBeVisible();
  const tabBtns = tabs.locator(".cm-lp-tab");
  // activate tab 2
  await tabBtns.nth(1).click();
  await sleep(200);
  await expect(tabBtns.nth(1)).toHaveClass(/cm-lp-tab-active/);
  // click the nested callout inside tab 2 (a re-render trigger)
  await tabs.locator(".cm-lp-callout-panel").first().click();
  await sleep(300);
  // tab 2 is STILL active (did not snap back to tab 1)
  await expect(tabBtns.nth(1), "tab 2 stays active after the nested click").toHaveClass(/cm-lp-tab-active/);
  await expect(tabBtns.nth(0)).not.toHaveClass(/cm-lp-tab-active/);
});

// Point 4: a pipe table nested inside a container renders as a real <table> (the shared nested renderer was
// missing the GFM Table extension, so it showed the raw `| a | b |` source).
test("#174-4: a pipe table nested in columns renders as a <table>", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "nested-pipe-table");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::columns\n:::column\n| A | B |\n| - | - |\n| 1 | 2 |\n:::\n:::column\nplain\n:::\n::::\n\nbelow\n");
  await sleep(600);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(600);

  const columns = page.locator("[data-pane=preview] [data-testid=macro-columns]").first();
  await expect(columns).toBeVisible();
  const table = columns.locator("table").first();
  await expect(table, "the nested pipe table renders as a real <table>").toBeVisible();
  await expect(table.locator("th")).toHaveCount(2);
  await expect(table.locator("tbody td")).toHaveCount(2);
});

// #278 E part 1, re-based on the A1 ruling: clicking a nested callout now enters the SLOT
// ISLAND (one-click slot entry). The width-stability concern survives translated: the island replaces the
// clicked cell in the SAME flex slot, the stays rendered (its removal was the measured 315→336px jump),
// so the OTHER column's width must not move and the island must stay contained beside it.
test("#278 E: entering a column's island does not reflow the neighbouring column", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
  await openScratch(page, "nested-callout-reflow"); await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\n:::warning\nhi there\n:::\n:::\n:::column\nBBB\n:::\n::::\n\nbot\n");
  await sleep(800);
  await page.getByText("bot", { exact: true }).click(); await sleep(300);
  const cols = page.locator("[data-pane=preview] [data-testid=macro-columns] .cm-lp-column");
  const before = await cols.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  expect(before.length).toBe(2);
  // click the nested warning callout → the SLOT ISLAND opens for that column (A1)
  await page.locator("[data-pane=preview] .cm-lp-callout-warning").first().click({ force: true }); await sleep(500);
  await expect(page.locator("[data-testid=slot-edit-island]"), "one click enters the slot island").toHaveCount(1);
  const state = await page.evaluate(() => {
    const other = document.querySelector("[data-pane=preview] [data-testid=macro-columns] .cm-lp-column") as HTMLElement | null;
    const island = document.querySelector("[data-testid=slot-edit-island]") as HTMLElement | null;
    const row = island?.closest(".cm-lp-columns") as HTMLElement | null;
    return {
      otherW: other ? Math.round(other.getBoundingClientRect().width) : null,
      islandRight: island ? Math.round(island.getBoundingClientRect().right) : null,
      rowRight: row ? Math.round(row.getBoundingClientRect().right) : null,
      plus: !!document.querySelector("[data-testid=layout-add-column]"),
    };
  });
  expect(state.plus, "the ＋ stays rendered while the island is open (no reflow source)").toBe(true);
  expect(Math.abs((state.otherW ?? 0) - before[1]!), `the untouched column keeps its width (was ${before[1]}, now ${state.otherW})`).toBeLessThanOrEqual(2);
  expect(state.islandRight! <= state.rowRight! + 1, "the island stays contained in the row (no explosion)").toBe(true);
});

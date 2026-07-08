import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #174 (review rejection comment 1071): four block-interaction fixes for nested macros, all in WYSIWYG.
// Real Chromium — nested-widget hit-testing / :has() hover suppression / re-render tab state can't be
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

// Point 3: innermost-wins — while a nested slot's ✎ is revealed on hover, the CONTAINER's own ✎ is
// suppressed (they used to co-occur).
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
  // the nested ✎ is shown, the container ✎ is hidden (opacity 0) while the nested slot is hovered.
  expect(Number(await opacity(wrap.getByTestId("nested-macro-edit")))).toBeGreaterThan(0);
  expect(await opacity(wrap.locator("> .cm-lp-macro-btnrow [data-testid=macro-edit]"))).toBe("0");
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

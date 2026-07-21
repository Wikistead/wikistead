import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #456 S2: Ctrl+↵ on a container enters a SLOT, not the raw fences. Which slot is the container's own
// answer (S1's `enter`): columns opens its first column, tabs opens the tab the reader is looking at.
// Before this, entering a container revealed its `:::` source — technically editable, but it dropped
// you into markup instead of the content you were reading.

const docText = (p: Page) => p.evaluate(() => {
  const ed = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
  const view = (ed?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as
    { state: { doc: { toString(): string } } };
  return view.state.doc.toString();
});

const TABS = "::::tabs\n:::tab[One]\nfirst tab body\n:::\n:::tab[Two]\nsecond tab body\n:::\n::::\n\nbelow\n";
const COLUMNS = "::::columns\n:::column\nleft body\n:::\n:::column\nright body\n:::\n::::\n\nbelow\n";

async function ready(browser: import("@playwright/test").Browser, body: string, label: string) {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `enter456-${label}-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(body);
  await sleep(900);
  await page.getByText("below", { exact: true }).click(); // caret off the container → it renders
  await sleep(400);
  return page;
}

test("#456: Ctrl+↵ on a columns container opens the FIRST column's island", async ({ browser }) => {
  const page = await ready(browser, COLUMNS, "columns");
  // Land the caret on the container with the KEYBOARD. Clicking a slot opens the island by itself
  // (the #278 click path), which would hide whether Ctrl+↵ did anything at all.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await sleep(300);
  await page.keyboard.press("Control+Enter");
  await sleep(600);

  const island = page.getByTestId("slot-edit-island");
  await expect(island, "the island opened rather than the raw fences").toBeVisible({ timeout: 8000 });
  // the island itself is a nested .cm-content, so scope the "no raw fences" check to the OUTER surface
  await expect(page.locator("[data-pane=preview] .lp-editor-host > .cm-editor > .cm-scroller > .cm-content")).not.toContainText(":::column");

  await page.keyboard.type("XX");
  await page.getByText("below", { exact: true }).click(); // blur commits
  await sleep(700);
  const doc = await docText(page);
  expect(doc, "the typing landed in the FIRST column").toMatch(/:::column\n[^:]*XX[^:]*\n:::\n:::column\nright body/);
});

test("#456: Ctrl+↵ on tabs opens the tab the reader is on, not always the first", async ({ browser }) => {
  const page = await ready(browser, TABS, "tabs");
  // switch to the second tab — this is display-only state, and it is what entry must follow
  await page.getByRole("button", { name: "Two" }).click();
  await sleep(400);
  await expect(page.getByText("second tab body")).toBeVisible();

  await page.click("[data-pane=preview] .cm-content"); // focus without landing in a slot
  await page.getByText("below", { exact: true }).click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await sleep(300);
  await page.keyboard.press("Control+Enter");
  await sleep(600);

  await expect(page.getByTestId("slot-edit-island")).toBeVisible({ timeout: 8000 });
  await page.keyboard.type("YY");
  await page.getByText("below", { exact: true }).click();
  await sleep(700);

  const doc = await docText(page);
  expect(doc, "the typing landed in the SECOND tab, the one on screen").toMatch(/:::tab\[Two\]\n[^:]*YY/);
  expect(doc, "…and the first tab is untouched").toContain("first tab body");
});

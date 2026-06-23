import { test, expect } from "@playwright/test";
import { openDemo, enterEdit, resetDoc, sleep } from "../helpers";

const content = (p: import("@playwright/test").Page) => p.locator("[data-pane=preview] .cm-content").innerText();

// M0-1 (ADR-017): the slash command palette. `/` at the start of a line opens a
// filterable insert/toggle menu in the CM tooltip layer; choosing a command removes
// the typed token and inserts plain Markdown into the canonical Y.Text.
test("slash palette: open, filter, apply with Enter", async ({ page }) => {
  await openDemo(page);
  await enterEdit(page);
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");

  // `/` at line start opens the palette with several commands
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  expect(await page.locator("[data-testid=slash-palette] .lp-palette-row").count()).toBeGreaterThan(3);

  // typing filters: "table" → only the Table command remains
  await page.keyboard.type("table");
  await expect(page.getByTestId("slash-item-table")).toBeVisible();
  expect(await page.getByTestId("slash-item-h1").count()).toBe(0);

  // Enter applies: the "/table" token is removed and a table template is inserted
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);
  expect(await content(page)).toContain("Column");
});

test("slash palette: click applies, Esc dismisses, no fire mid-prose", async ({ page }) => {
  await openDemo(page);
  await enterEdit(page);

  // click on a row applies (code block)
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/");
  await page.getByTestId("slash-item-code").click();
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);
  // the caret lands inside the block, so the ``` fences are reveal-hidden; assert the
  // tinted code content line instead of the raw fences.
  expect(await page.locator("[data-pane=preview] .cm-lp-code-line").count()).toBeGreaterThan(0);

  // Esc dismisses but keeps the typed "/" as text
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);
  expect(await content(page)).toContain("/");

  // mid-prose "/" (not at line start) does NOT open the palette
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("ab/");
  await sleep(150);
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);
});

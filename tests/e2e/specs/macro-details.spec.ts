import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #90 (ADR-043, option A): :::details collapses to a "▸ summary" bar when the caret is away, and
// reveals the raw source (reveal-on-cursor) when the caret is inside. Display-only collapse.
test(":::details collapses to a summary bar; caret-in reveals the raw source + body", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "details");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More info]\nthe hidden body\n:::\n\nbelow\n");
  await sleep(400);

  // Collapsed: a summary bar with the label; the body is NOT shown.
  const bar = page.locator("[data-pane=preview] [data-testid=macro-details]");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("More info");
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("the hidden body");

  // Click the bar → caret enters → raw source revealed (the directive text + the body).
  await bar.click();
  await sleep(250);
  const revealed = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(revealed).toContain(":::details[More info]");
  expect(revealed).toContain("the hidden body");
});

import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #174 comment 894: in WYSIWYG the callout renders as a panel and the syntax never reveals, so the
// panel needs its OWN edit entry (✎ + Ctrl+↵) that opens the callout editUI. Real Chromium.
test("#174: WYSIWYG callout panel has a ✎ edit entry that opens the editUI", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "wys-callout");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::warning\nwatch out\n:::\n\nbelow\n");
  await sleep(400);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(400);
  // the callout renders as a panel (icon + body), NOT raw
  const panel = page.locator("[data-pane=preview] .cm-lp-callout-panel").first();
  await expect(panel).toBeVisible();
  const raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw).not.toContain(":::warning"); // WYSIWYG hides syntax
  // hover the panel → the ✎ edit button appears; click it → the editUI island mounts
  await panel.hover();
  const edit = page.getByTestId("callout-panel-edit");
  await expect(edit).toBeVisible();
  await edit.click();
  await sleep(300);
  // the callout editUI (type/header/content) is now mounted (its inline editor island)
  await expect(page.getByTestId("callout-edit-type")).toBeVisible();
});

import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #174 / ADR-087 (Class 1 — direct-click metadata): clicking a rendered callout's icon badge opens a type
// picker; picking a type rewrites the directive name in place (one offset-invariant Y.Text edit), and the
// callout re-renders with the new variant class. The source stays :::type (Open formats / single Y.Text).
test("#174 class1: clicking a callout badge opens a type picker that changes the type", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout-badge");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n:::note\nhello body\n:::\n\nbottom\n");
  await sleep(500);
  const panel = page.locator("[data-pane=preview] .cm-lp-callout-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/cm-lp-callout-note/); // starts as a note
  // click the icon badge → the type menu opens
  await page.getByTestId("callout-type-badge").click();
  await expect(page.getByTestId("callout-type-menu")).toBeVisible();
  // pick "warning"
  await page.getByTestId("callout-type-warning").click();
  await sleep(300);
  // the callout re-rendered as a warning. The variant class is derived ONLY by parsing the directive name
  // (`:::warning` → the warning macro → containerClass cm-lp-callout-warning), so class == the rewritten
  // source — this proves the type change hit the Y.Text (a note that hadn't changed would stay note-classed).
  await expect(page.locator("[data-pane=preview] .cm-lp-callout-panel")).toHaveClass(/cm-lp-callout-warning/);
  await expect(page.locator("[data-pane=preview] .cm-lp-callout-panel")).not.toHaveClass(/cm-lp-callout-note/);
  await expect(page.getByTestId("callout-type-menu")).toHaveCount(0); // menu closed after picking
});

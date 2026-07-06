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

// #174 comment 878 (ADR-087 addendum 2): a Live click on a callout PLACES THE CARET (reveals raw source),
// it does NOT open the editUI panel directly. The RichUI is reached via the shared caret-in pill / Ctrl+Enter
// — the same affordance as the pipe table (#216). Verified in a real browser (the #216 show/no-show saga).
test("#174 comment 878: Live click reveals raw + a RichUI-entry pill (not the editUI panel directly)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout-richui-pill");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n:::note[Heads up]\nhello body\n:::\n\nbottom\n");
  await sleep(500);
  const panel = page.locator("[data-pane=preview] .cm-lp-callout-panel");
  await expect(panel).toBeVisible();
  // caret-out (rendered panel): NO pill, NO editUI panel.
  await expect(page.getByTestId("callout-richui-enter")).toHaveCount(0);
  await expect(page.getByTestId("callout-edit-type")).toHaveCount(0);

  // Click the callout body (not the icon badge) → caret enters → raw source revealed, NOT the editUI panel.
  await panel.locator(".cm-lp-callout-panel-main").click();
  await sleep(250);
  const content = page.locator("[data-pane=preview] .cm-content");
  expect(await content.innerText()).toContain(":::note[Heads up]"); // raw source visible
  await expect(page.getByTestId("callout-edit-type")).toHaveCount(0); // the click did NOT open the editUI panel

  // The shared RichUI-entry pill appears in the caret-in raw state, always-visible.
  const pill = page.getByTestId("callout-richui-enter");
  await expect(pill).toHaveCount(1);
  await expect(pill).toContainText("Ctrl+↵");
  const op = Number(await pill.evaluate((el) => getComputedStyle(el).opacity));
  expect(op).toBeGreaterThan(0.4); // visible without hover

  // Pill click → the editUI panel opens (Type / Header / Content).
  await pill.click();
  await sleep(250);
  await expect(page.getByTestId("callout-edit-type")).toBeVisible();
});

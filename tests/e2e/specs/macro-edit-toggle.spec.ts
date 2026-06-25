import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 (ADR-022 Part 11): the reveal↔render toggle + caret-context hint, common to every
// richEditUI macro. On the modal exemplar (Excalidraw): the caret on the block shows the
// "<key> edit" hint, and the toggle key (Ctrl+Enter) opens the modal. A macro WITHOUT a
// richEditUI (mermaid) shows NO hint.
test("macro-edit hint + Ctrl+Enter opens the modal exemplar (Excalidraw); none for mermaid", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "macroedit");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of ["```excalidraw", "```", "", "```mermaid", "graph TD; A-->B;", "```", "", "below"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);

  // Caret onto the Excalidraw block → the "<key> edit" hint shows.
  await page.locator("[data-pane=preview] [data-testid=macro-excalidraw]").click();
  await sleep(150);
  await expect(page.getByTestId("macro-edit-hint")).toBeVisible();
  await expect(page.getByTestId("macro-edit-hint")).toContainText("edit");

  // Toggle key opens the modal (no ✎ click needed).
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("macro-modal")).toBeVisible();
  await expect(page.locator(".wks-macro-modal .excalidraw")).toBeVisible({ timeout: 20000 });
  await page.getByTestId("macro-modal-cancel").click();
  await expect(page.getByTestId("macro-modal")).toHaveCount(0);

  // mermaid has NO richEditUI → no hint when the caret is on it.
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").click();
  await sleep(150);
  await expect(page.getByTestId("macro-edit-hint")).toHaveCount(0);
});

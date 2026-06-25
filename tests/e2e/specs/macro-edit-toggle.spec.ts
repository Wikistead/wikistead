import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 (ADR-022 Part 11, mode-based): the Ctrl+Enter toggle + "edit" hint are gone; rich
// edit is launched by a CLICK. A macro with no rich editor (mermaid) does NOT open a
// modal on click. (Clicking Excalidraw → modal is covered by macro-excalidraw.spec.)
test("no edit hint; clicking a non-rich macro (mermaid) opens no modal", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "macroclick");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of ["```mermaid", "graph TD; A-->B;", "```", "", "below"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(300);

  // The Ctrl+Enter mechanism is removed → no "edit" hint anywhere.
  expect(await page.getByTestId("macro-edit-hint").count()).toBe(0);

  // Clicking mermaid (no richEditUI) reveals/places the caret — it never opens a modal.
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").click();
  await sleep(150);
  expect(await page.getByTestId("macro-modal").count()).toBe(0);
});

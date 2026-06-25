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

// #5 (the REAL device path, with a NON-rich macro): in vim, the caret on a mermaid block
// reveals its raw source; switching to non-vim — WITHOUT moving the caret — must render
// it (non-vim renders EVERY macro, not just rich-editable ones). This is the exact case
// that regressed on device: `revealAllowed` let non-rich macros reveal in non-vim too.
test("vim→non-vim renders a non-rich (mermaid) macro under the caret, no caret move", async ({ browser }) => {
  test.setTimeout(45000);
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "mermaidmode");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "true");

  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.press("i");
  for (const line of ["```mermaid", "graph TD; A-->B;", "```"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("g"); // caret onto the mermaid block → vim reveals raw source
  await sleep(250);
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").count()).toBe(0);

  // Toggle vim OFF — do NOT touch the caret. The mermaid must render.
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible({ timeout: 15000 });
});

// ADR-024 Q1: Ctrl+Enter "enters" the macro atom at the caret (the keyboard path; vim
// users never need the mouse). For an inline macro (table) entering opens the cell-edit
// widget. (Additive first brick of the atom model — auto-reveal removal comes later.)
test("vim Ctrl+Enter enters the macro atom at the caret (table → cell edit)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "ctrlenter");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "true");

  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.press("i");
  for (const line of [":::table", "<table><tr><td>1</td><td>2</td></tr></table>", ":::", "", "tail"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("g"); // caret onto the table atom
  await sleep(250);
  expect(await page.getByTestId("table-edit").count()).toBe(0); // not yet entered
  await page.keyboard.press("Control+Enter");
  await sleep(250);
  await expect(page.getByTestId("table-edit")).toBeVisible(); // entered → cell-edit widget
});

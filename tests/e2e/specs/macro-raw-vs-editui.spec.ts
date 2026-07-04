import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #174 / ADR-087 addendum (reviewer-approved): a ``` -notation macro (mermaid) is entered TWO ways with
// DIFFERENT results — Ctrl+Enter (vim×Live) reveals the RAW source (vim-editable), the ✎ edit button
// opens the rich editUI (source textarea + live preview). Verified in a real browser: the raw-vs-editUI
// routing is a rendered/keymap concern happy-dom can't exercise. Guards the split from regressing back
// to "Ctrl+Enter opens the editUI" (which broke the atom-motion source-reveal contract).
test("#174: mermaid Ctrl+Enter reveals raw source; the ✎ button opens the editUI", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "raw-vs-editui");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\ngraph TD\nA-->B\n```\nbot\n");
  await sleep(600);

  // Caret off the block → it renders as an atom (no raw fence, no editUI textarea).
  await page.getByText("bot").click();
  await sleep(200);
  await expect(page.getByTestId("macro-mermaid").first()).toBeVisible();
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("```mermaid");
  await expect(page.getByTestId("mermaid-edit-src")).toHaveCount(0);

  // Ctrl+Enter → RAW source revealed (the vim-editable fence), NOT the editUI textarea.
  await page.getByTestId("macro-mermaid").first().click(); // caret onto the atom
  await sleep(120);
  await page.keyboard.press("Control+Enter");
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("```mermaid");
  await expect(page.getByTestId("mermaid-edit-src")).toHaveCount(0); // NOT the editUI

  // Move the caret out to re-render the atom, then the ✎ edit button → the editUI (textarea + preview).
  await page.keyboard.press("Escape");
  await page.getByText("bot").click();
  await sleep(200);
  await page.getByTestId("macro-mermaid").first().hover();
  await sleep(120);
  await page.getByTestId("macro-edit").first().click({ force: true });
  await sleep(300);
  await expect(page.getByTestId("mermaid-edit-src")).toHaveCount(1); // the editUI source textarea
  expect(await page.getByTestId("mermaid-edit-src").inputValue()).toContain("graph TD");
});

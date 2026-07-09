import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #243 / ADR-111 (C1 + C4): mermaid and plantuml join the CALLOUT edit class. The routing is now:
//   - a bare caret INSIDE (a click / vim landing) reveals the RAW source (vim-editable) — C1
//   - Ctrl+Enter AND the ✎ button BOTH open the rich editUI (source textarea + live preview) — C4
// This REVISES ADR-024/ADR-087's prior split ("Ctrl+Enter reveals raw, ✎ opens the editUI"): raw is now the
// caret-in reveal, and Ctrl+Enter is unified with ✎ onto the editUI (as callout's Ctrl+Enter/✎ already were).
// Verified in a real browser — the raw-vs-editUI routing is a rendered/keymap concern happy-dom can't exercise.
test("#243: mermaid caret-in reveals raw; Ctrl+Enter AND the ✎ button open the editUI", async ({ browser }) => {
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

  // C1: a caret INSIDE (click) reveals the RAW source (the vim-editable fence), NOT the editUI textarea.
  await page.getByTestId("macro-mermaid").first().click();
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("```mermaid");
  await expect(page.getByTestId("mermaid-edit-src")).toHaveCount(0);

  // C4: Ctrl+Enter → the editUI (source textarea + preview), NOT raw.
  await page.keyboard.press("Control+Enter");
  await sleep(300);
  await expect(page.getByTestId("mermaid-edit-src")).toHaveCount(1);
  expect(await page.getByTestId("mermaid-edit-src").textContent()).toContain("graph TD"); // #243 C3: CM6 content, not a textarea

  // Exit the editUI (Done) → the atom re-renders; then the ✎ button opens the SAME editUI (C4 parity).
  await page.getByTestId("editui-done").click({ force: true });
  await sleep(400);
  await expect(page.getByTestId("macro-mermaid").first()).toBeVisible();
  await page.getByTestId("macro-mermaid").first().hover();
  await sleep(120);
  await page.getByTestId("macro-edit").first().click({ force: true });
  await sleep(300);
  await expect(page.getByTestId("mermaid-edit-src")).toHaveCount(1); // the editUI source textarea
  expect(await page.getByTestId("mermaid-edit-src").textContent()).toContain("graph TD"); // #243 C3: CM6 content, not a textarea
});

// #243: plantuml gets the SAME callout-class routing (caret-in raw; Ctrl+Enter / ✎ → editUI).
test("#243: plantuml caret-in reveals raw; Ctrl+Enter AND the ✎ button open the editUI", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "plantuml-raw-vs-editui");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```plantuml\n@startuml\nA -> B\n@enduml\n```\nbot\n");
  await sleep(500);

  // Caret off → rendered as the atom (degraded code block); no raw fence, no editUI textarea.
  await page.getByText("bot").click();
  await sleep(200);
  await expect(page.getByTestId("macro-plantuml").first()).toBeVisible();
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("```plantuml");
  await expect(page.getByTestId("plantuml-edit-src")).toHaveCount(0);

  // C1: caret-in (click) → raw fence revealed, NOT the editUI.
  await page.getByTestId("macro-plantuml").first().click();
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("```plantuml");
  await expect(page.getByTestId("plantuml-edit-src")).toHaveCount(0);

  // C4: Ctrl+Enter → the editUI source textarea.
  await page.keyboard.press("Control+Enter");
  await sleep(300);
  await expect(page.getByTestId("plantuml-edit-src")).toHaveCount(1);
  expect(await page.getByTestId("plantuml-edit-src").textContent()).toContain("@startuml"); // #243 C3: CM6 content, not a textarea

  // Exit (Done) → atom; the ✎ button opens the SAME editUI.
  await page.getByTestId("editui-done").click({ force: true });
  await sleep(400);
  await page.getByTestId("macro-plantuml").first().hover();
  await sleep(120);
  await page.getByTestId("macro-edit").first().click({ force: true });
  await sleep(250);
  await expect(page.getByTestId("plantuml-edit-src")).toHaveCount(1);
  expect(await page.getByTestId("plantuml-edit-src").textContent()).toContain("@startuml"); // #243 C3: CM6 content, not a textarea
});

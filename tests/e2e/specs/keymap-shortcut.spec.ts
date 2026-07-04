import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #2: Ctrl+Alt+V toggles the editor's vim keymap for the current session, from the
// keyboard (no need for the toolbar button). The toggle's state shows on the vim-toggle
// switch (aria-pressed toggle button). Device-local / session — editor-core safe.
test("Ctrl+Alt+V toggles vim from the keyboard", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "km-shortcut");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");

  const toggle = page.getByTestId("vim-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Control+Alt+v");
  await sleep(80);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Control+Alt+v");
  await sleep(80);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

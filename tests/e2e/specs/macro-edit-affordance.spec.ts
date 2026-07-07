import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #254: the ✎ edit button on a RENDERED richEditUI macro (e.g. excalidraw) must be hidden until the block
// is hovered or selected — NOT always visible. It regressed because the button shared the
// cm-lp-macro-richui-raw class (opacity:0.8 always), which is only correct for the raw-editing entry pill.
// Real Chromium (opacity is computed).
test("#254: a richEditUI macro's edit button is hidden until hover/selection", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "edit-affordance");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // A NON-empty excalidraw fence (empty renders a placeholder with no ✎). insertText inserts literally
  // (no fence auto-close). The caret lands at the end (on "below text"), so the macro is NOT selected.
  await page.keyboard.insertText('```excalidraw\n{"type":"excalidraw","version":2,"elements":[],"appState":{}}\n```\nbelow text\n');
  await sleep(600);
  const macro = page.locator("[data-pane=preview] [data-testid=macro-excalidraw]");
  await expect(macro).toBeVisible();

  // Idle: caret is off the macro; move the pointer away too → the ✎ must be hidden (opacity ~0).
  await page.mouse.move(2, 2);
  await sleep(300);
  const editBtn = page.getByTestId("macro-edit").first();
  await expect(editBtn).toHaveCount(1);
  const opacityIdle = Number(await editBtn.evaluate((el) => getComputedStyle(el).opacity));
  expect(opacityIdle, `edit button should be hidden when idle (got opacity ${opacityIdle})`).toBeLessThan(0.5);

  // Hovering the macro block reveals it.
  await macro.hover();
  await sleep(300);
  const opacityHover = Number(await editBtn.evaluate((el) => getComputedStyle(el).opacity));
  expect(opacityHover, `edit button should be visible on hover (got opacity ${opacityHover})`).toBeGreaterThan(0.9);
});

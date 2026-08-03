import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #600 (review rejection, 2026-08-04): an empty `:::todo` drew NOTHING — three blank rows where a block
// was. Every other macro says what it is when it has no content; this one vanished, which is worse than
// saying nothing: the block is still there, still typed into, and the screen gives no sign of it.
//
// It vanished for a structural reason, which is why it survived a pin: a todo block is LINE decorations
// (the ring, the gutter icon, the rounded box are all per-line), and an empty block has no lines to
// decorate. The discovery pin walked `dispatchMacroRender` and accepted "returns nothing" silently — so
// the one macro that rendered nothing was the one it could not see.
test("#600: an empty todo block says what it is", async ({ page }) => {
  test.setTimeout(120_000);
  await openScratch(page, `todo-empty-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "head paragraph\n\n:::todo\n:::\n\ntail paragraph\n" } });
  });
  await sleep(900);

  const label = page.locator("[data-pane=preview] [data-testid=macro-empty]");
  await expect(label, "the empty block is on the screen at all").toHaveCount(1);
  const text = (await label.innerText()).trim();
  expect(text.length, "and it is not an empty label").toBeGreaterThan(0);
  // it names itself, in the reader's language, through the same template as every other placeholder
  expect(text, `the label says which macro it is: ${text}`).toMatch(/To-do|ToDo|進捗/i);
});

test("#600: a todo block WITH tasks is unchanged", async ({ page }) => {
  test.setTimeout(120_000);
  await openScratch(page, `todo-filled-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ":::todo\n- [ ] one\n- [x] two\n:::\n" } });
  });
  await sleep(900);

  await expect(page.getByTestId("todo-block-icon"), "the block still draws its gutter icon").toHaveCount(1);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-empty]"), "and no empty label is added to it").toHaveCount(0);
});

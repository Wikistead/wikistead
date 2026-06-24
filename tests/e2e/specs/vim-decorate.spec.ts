import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const content = (p: Page) => p.locator("[data-pane=preview] .cm-content").innerText();
const head = (p: Page) => p.evaluate(() => (window as Window & { __lpHeadLine?: number }).__lpHeadLine);

// M0-3 (ADR-018): vim VISUAL `\` opens the selection (decorate) palette — matched by
// key CODE (Backslash/IntlRo/IntlYen) so JIS `¥` doesn't mangle it. `\` is not typed
// (offset-invariant). A small hint shows during a visual selection. Normal/visual `/`
// stays vim search (untouched).
test("vim visual \\ opens the decorate palette (\\ not typed) and applies a format", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim-bs");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("hello world");
  const before = await content(page);

  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await page.click("[data-pane=preview] .cm-content"); // refocus (toggle took focus)
  await page.keyboard.press("Escape"); // normal mode
  await page.keyboard.press("0"); // line start
  await page.keyboard.press("v"); // visual
  await page.keyboard.press("e"); // select to word end → "hello"
  await sleep(120);

  await page.keyboard.press("\\");
  await expect(page.getByTestId("decorate-palette")).toBeVisible();
  expect(await content(page)).toBe(before); // `\` was NOT typed → document/offsets intact

  // apply bold from the palette
  await page.getByTestId("decorate-item-bold").click();
  await sleep(150);
  expect(await content(page)).toContain("**"); // the visual selection was wrapped
});

test("vim visual hint: shown only in visual mode, display-only (no doc/offset change)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim-hint");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("hello");
  const hint = page.getByTestId("vim-decorate-hint");

  // non-vim selection → no vim hint
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(hint).toBeHidden();

  // vim normal mode → still no hint
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await expect(hint).toBeHidden();

  // vim visual selection → the hint appears
  await page.keyboard.press("0");
  await page.keyboard.press("v");
  await page.keyboard.press("e");
  await sleep(120);
  const lineBefore = await head(page);
  await expect(hint).toBeVisible();
  // the hint takes the ribbon spot: the full toolbar bubble is suppressed in vim visual
  await expect(page.getByTestId("format-bubble")).toHaveCount(0);

  // display-only: it adds no text and is NOT inside the editable content (so it cannot
  // affect document offsets / presence); the caret line is unchanged.
  expect(await content(page)).toBe("hello");
  expect(await page.locator("[data-pane=preview] .cm-content [data-testid=vim-decorate-hint]").count()).toBe(0);
  expect(await head(page)).toBe(lineBefore);
});

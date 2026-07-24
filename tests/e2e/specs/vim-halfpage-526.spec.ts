import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #526: vim's Ctrl-D (half page down) must STOP at the end of the document. The bundled
// @replit/codemirror-vim wraps instead: pressing Ctrl-D with the caret on the last line jumps the caret
// back to offset 0 (measured: head 11115 → 0, scrollTop max → 0), which reads as "held Ctrl-D cycles back
// to the top". Ctrl-U has the mirror hazard at the start. Pinned on a real browser measuring the CARET
// (the doc position, via the DEV __lpSel probe) — not just the scroll offset.

function longDoc(): string {
  let s = "# Half page\n\n";
  for (let i = 0; i < 200; i++) s += `line ${i} — the quick brown fox jumps over the lazy dog\n\n`;
  return s + "TAILMARK\n";
}

const readCaret = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __lpHeadLine?: number; __lpSel?: { head: number } };
    const sc = document.querySelector("[data-pane=preview] .cm-scroller") as HTMLElement | null;
    return {
      line: w.__lpHeadLine ?? -1,
      head: w.__lpSel?.head ?? -1,
      scrollTop: sc ? Math.round(sc.scrollTop) : -1,
      max: sc ? Math.round(sc.scrollHeight - sc.clientHeight) : -1,
      docLen: (document.querySelector("[data-pane=preview] .cm-content") as HTMLElement | null) ? -1 : -1,
    };
  });

async function ctrl(page: import("@playwright/test").Page, key: string) {
  await page.keyboard.down("Control");
  await page.keyboard.press(key);
  await page.keyboard.up("Control");
  await sleep(200);
}

test("#526: Ctrl-D at the end of the document does NOT wrap to the top", async ({ page }) => {
  await openScratch(page, `vimhp-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(longDoc());
  await sleep(600);
  // vim ON
  const vimBtn = page.locator("[data-testid=vim-toggle], [data-testid=toggle-vim]").first();
  if (await vimBtn.count()) { await vimBtn.click(); await sleep(500); }
  // focus the content without a click (a long doc keeps re-rendering, which stalls Playwright's
  // stability wait), then leave insert mode
  await page.evaluate(() => (document.querySelector("[data-pane=preview] .cm-content") as HTMLElement | null)?.focus());
  await page.keyboard.press("Escape");
  await sleep(300);

  // the caret is at the end after inserting; confirm, then press Ctrl-D
  const atEnd = await readCaret(page);
  expect(atEnd.line, "precondition: the caret starts on the last line").toBeGreaterThan(300);

  await ctrl(page, "d");
  const after = await readCaret(page);
  // THE BUG: the caret jumped back to the very top (head 0 / line 1). It must stay at the end instead.
  expect(after.head, "Ctrl-D at EOF must not send the caret back to the document start").toBeGreaterThan(atEnd.head - 200);
  expect(after.line, "Ctrl-D at EOF keeps the caret near the end (no wrap)").toBeGreaterThan(300);
  expect(after.scrollTop, "the view stays at the bottom too").toBeGreaterThan(after.max - 200);

  // and holding it does not wander back either
  await ctrl(page, "d");
  await ctrl(page, "d");
  const held = await readCaret(page);
  expect(held.line, "repeated Ctrl-D at EOF is a no-op, never a wrap").toBeGreaterThan(300);
});

test("#526: Ctrl-U at the start of the document does NOT wrap to the bottom", async ({ page }) => {
  await openScratch(page, `vimhpu-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(longDoc());
  await sleep(600);
  const vimBtn = page.locator("[data-testid=vim-toggle], [data-testid=toggle-vim]").first();
  if (await vimBtn.count()) { await vimBtn.click(); await sleep(500); }
  await page.evaluate(() => (document.querySelector("[data-pane=preview] .cm-content") as HTMLElement | null)?.focus());
  await page.keyboard.press("Escape");
  await sleep(300);

  // go to the top (gg), then press Ctrl-U
  await page.keyboard.type("gg");
  await sleep(400);
  const atTop = await readCaret(page);
  expect(atTop.line, "precondition: the caret is at the top").toBeLessThan(5);

  await ctrl(page, "u");
  const after = await readCaret(page);
  expect(after.line, "Ctrl-U at the start must not wrap to the end").toBeLessThan(30);
  expect(after.scrollTop, "the view stays at the top").toBeLessThan(400);
});

test("#526: Ctrl-D still pages down normally mid-document", async ({ page }) => {
  await openScratch(page, `vimhpm-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(longDoc());
  await sleep(600);
  const vimBtn = page.locator("[data-testid=vim-toggle], [data-testid=toggle-vim]").first();
  if (await vimBtn.count()) { await vimBtn.click(); await sleep(500); }
  await page.evaluate(() => (document.querySelector("[data-pane=preview] .cm-content") as HTMLElement | null)?.focus());
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.keyboard.type("gg");
  await sleep(400);

  const start = await readCaret(page);
  await ctrl(page, "d");
  const one = await readCaret(page);
  await ctrl(page, "d");
  const two = await readCaret(page);
  expect(one.line, "one Ctrl-D moves down a half page").toBeGreaterThan(start.line + 3);
  expect(two.line, "a second Ctrl-D keeps going down").toBeGreaterThan(one.line + 3);
  // and Ctrl-U comes back up
  await ctrl(page, "u");
  const back = await readCaret(page);
  expect(back.line, "Ctrl-U pages back up").toBeLessThan(two.line - 3);
});

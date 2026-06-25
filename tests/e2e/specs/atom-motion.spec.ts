import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// ADR-024 1b: a macro is an ATOM. It renders in vim (no auto-reveal), vim j/k step OVER it
// as a single motion stop (crucially for a TALL multi-line macro — a short one never
// overshoots, which is why earlier empty-macro traces passed while the device failed), it
// is highlighted when the caret is on it, entered explicitly (Ctrl+Enter), and dd removes
// the WHOLE macro. We build a TALL non-empty mermaid via insertText (paste-like — bypasses
// the editor's per-char auto-close/auto-pair that mangles typed fences).
// Doc lines: 1 top · 2-6 ```mermaid (3 body lines) · 7 mid · 8 bot · 9 (trailing).
async function insertTallMermaid(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\ngraph TD\nA-->B\nA-->C\n```\nmid\nbot\n");
  await sleep(400);
}
const blocks = (page: any) => page.evaluate(() => (window as any).__lpBlocks ?? []);
const headLine = (page: any) => page.evaluate(() => (window as any).__lpHeadLine);
async function vimOn(page: any) {
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
}

test("a tall macro is a single atom range covering its whole fence", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-range");
  await enterEdit(page);
  await insertTallMermaid(page);
  // ONE atom whose range spans the whole ```mermaid…``` fence (lines 2-6), not just one line.
  expect(await blocks(page)).toEqual([{ fromLine: 2, toLine: 6 }]);
});

test("vim j/k step over a TALL macro atom as ONE stop; gg/G not hijacked", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-motion");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);

  await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(110);
  expect(await headLine(page)).toBe(1); // gg → top, not hijacked
  await page.keyboard.press("j"); await sleep(100);
  expect(await headLine(page)).toBe(2); // lands ON the atom (one stop)
  await page.keyboard.press("j"); await sleep(100);
  expect(await headLine(page)).toBe(7); // steps off PAST the whole atom (skips 3-6), NO overshoot to 8
  // up direction from the line just below the atom: one stop on the atom, then past it.
  await page.keyboard.press("k"); await sleep(100);
  expect(await headLine(page)).toBe(6); // lands ON the atom from below (one stop)
  await page.keyboard.press("k"); await sleep(100);
  expect(await headLine(page)).toBe(1); // steps off PAST the atom up to top (skips 5-2)

  await page.keyboard.press("G"); await sleep(100);
  expect(await headLine(page)).toBeGreaterThanOrEqual(8); // G → last line, not hijacked onto the atom
});

test("the atom is highlighted only when the caret is on it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-hl");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(110);
  expect(await page.locator("[data-pane=preview] .cm-lp-atom-sel").count()).toBe(0); // on top
  await page.keyboard.press("j"); await sleep(110);
  expect(await page.locator("[data-pane=preview] .cm-lp-atom-sel").count()).toBe(1); // on atom
});

test("Ctrl+Enter enters the atom (reveals the macro source)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-enter");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await page.keyboard.press("j"); await sleep(110);
  expect((await blocks(page)).length).toBe(1); // rendered atom
  await page.keyboard.press("Control+Enter"); await sleep(200);
  // entered → raw source revealed (the fence drops out of the atom blocks)
  expect((await blocks(page)).length).toBe(0);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("```mermaid");
});

test("dd on a TALL macro atom deletes the whole macro verbatim", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-dd");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await page.keyboard.press("j"); await sleep(110); // land on atom
  await page.keyboard.press("d"); await page.keyboard.press("d"); await sleep(200);
  expect((await blocks(page)).length).toBe(0); // macro gone
  const text = (await page.locator("[data-pane=preview] .cm-content").innerText()).replace(/\n+/g, "|").replace(/\|$/, "");
  expect(text).toBe("top|mid|bot"); // whole fence removed verbatim; surrounding lines intact
});

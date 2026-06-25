import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// ADR-024 1b: a macro is an ATOM. It renders in BOTH vim and non-vim (no auto-reveal on
// cursor), vim j/k step OVER it as a single motion stop, and it is entered explicitly
// (Ctrl+Enter / click) to edit. Built with a slash-inserted mermaid (a CLEAN macro —
// typing ``` fences / HTML directly is mangled by the editor's auto-close / auto-pair).
async function insertMermaidAtom(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("top");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/mermaid");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.keyboard.press("Enter");
  await sleep(300);
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("mid");
  await page.keyboard.press("Enter");
  await page.keyboard.type("bot");
  await sleep(200);
  // doc: 1 top · 2-4 ```mermaid (empty body) · 5 mid · 6 bot
}

test("a macro renders as an atom (no auto-reveal) with the caret right after it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-render");
  await enterEdit(page);
  await insertMermaidAtom(page);
  // The empty mermaid renders the placeholder atom even though the caret is just after it
  // (non-vim, no auto-reveal). The raw fence is NOT shown.
  await expect(page.locator("[data-pane=preview] [data-testid=macro-empty]")).toBeVisible();
});

test("vim j/k treat a macro atom as ONE motion stop and step over it; gg/G not hijacked", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-motion");
  await enterEdit(page);
  await insertMermaidAtom(page);
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  const head = async () => page.evaluate(() => (window as any).__lpHeadLine);

  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await sleep(120);
  expect(await head()).toBe(1); // gg → top, NOT hijacked onto the atom

  await page.keyboard.press("j");
  await sleep(100);
  const onAtom = await head(); // lands ON the atom (its near edge) — one stop
  expect(onAtom).toBeGreaterThan(1);
  await page.keyboard.press("j");
  await sleep(100);
  const past = await head(); // one more key steps off PAST the whole atom
  expect(past).toBeGreaterThan(onAtom + 1); // skipped the atom's interior lines = one stop

  await page.keyboard.press("G");
  await sleep(100);
  const atG = await head();
  expect(atG).toBeGreaterThan(past - 1); // G → last line, not hijacked onto the atom
});

test("Ctrl+Enter enters a macro atom (mermaid → its source is revealed)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-enter");
  await enterEdit(page);
  await insertMermaidAtom(page);
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await page.keyboard.press("j"); // land on the atom
  await sleep(120);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-empty]")).toBeVisible();
  await page.keyboard.press("Control+Enter");
  await sleep(200);
  // Entered → the atom's raw source is revealed (the rendered placeholder is gone).
  await expect(page.locator("[data-pane=preview] [data-testid=macro-empty]")).toHaveCount(0);
});

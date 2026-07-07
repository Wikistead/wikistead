import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #240: in WYSIWYG + vim, the block ("fat") cursor must NEVER paint a hidden syntax glyph (a link's
// [ ]( ) or a **/` mark), and vim h/l must step by EVERY VISIBLE char (no phantom, no skip). Real Chromium
// (the fat cursor is a separate render layer that reads the raw doc char — synthetic DOM can't reproduce
// it). Comment 960: the earlier spec never refocused the editor after the display-mode click, so `h` was
// absorbed by the button and the cursor never moved — a vacuous green. This refocuses and asserts the
// actual per-step fat-cursor letters cover the visible string.
const fatLetter = (page: any) => page.evaluate(() => {
  const el = document.querySelector("[data-pane=preview] .cm-fat-cursor");
  return el ? (el.textContent ?? "") : "__none__";
});
const HIDDEN = new Set(["[", "]", "(", ")", "*", "`", "|", ":"]);

async function vimWysiwyg(page: any, doc: string) {
  await page.getByTestId("vim-toggle").click().catch(async () => {
    await page.locator("[data-testid=vim-toggle], [aria-label*=vim i]").first().click();
  });
  await sleep(200);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("i"); // insert mode to type
  await page.keyboard.insertText(doc);
  await page.keyboard.press("Escape"); // back to normal
  await sleep(150);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(400);
  // comment 960: REFOCUS the editor after the mode-switch click (else keys hit the button — vacuous green).
  await page.click("[data-pane=preview] .cm-line");
  await sleep(150);
  await page.keyboard.press("Escape");
}

test("#240: vim normal fat cursor never shows a hidden syntax char in WYSIWYG", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "wys-vim-caret");
  await enterEdit(page);
  await vimWysiwyg(page, "x [hoge](https://ex.test/pq) y");
  await page.keyboard.type("$");
  await sleep(150);
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    const l = await fatLetter(page);
    seen.push(l);
    expect(HIDDEN.has(l.trim()), `fat cursor painted a hidden syntax char "${l}" (step ${i}); trail=${JSON.stringify(seen)}`).toBe(false);
    await page.keyboard.type("h");
    await sleep(80);
  }
});

// #240 comment 960: leftward `h` over a line MIXING bold + link + code must stop on EVERY visible char
// (the reported skip: the between-char filter snapped onto a hidden char and the guard re-corrected,
// dropping a visible stop and cascading across adjacent runs). Assert the fat-cursor letters visited by
// repeated `h` cover the visible string with no skipped visible char.
test("#240: vim h (leftward) stops on every visible char across mixed inline marks", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "wys-vim-h");
  await enterEdit(page);
  // visible chars: "mix bo ln cd end"
  await vimWysiwyg(page, "mix **bo** [ln](https://ex.test/a) `cd` end");
  await page.keyboard.type("$");
  await sleep(150);

  // collect the RAW fat-cursor letter at each stop (spaces matter — a space is a valid vim stop), walking
  // left with `h` to the line start. Trim ONLY for the hidden-char check.
  const letters: string[] = [];
  for (let i = 0; i < 30; i++) {
    const raw = await fatLetter(page);
    expect(HIDDEN.has(raw.trim()), `hidden char "${raw}" on the fat cursor (step ${i}); trail=${JSON.stringify(letters)}`).toBe(false);
    if (i === 0 || letters[letters.length - 1] !== raw) letters.push(raw);
    await page.keyboard.type("h");
    await sleep(60);
  }
  // The visible line read right-to-left. Every visible char (including spaces) must appear, in order —
  // a skipped visible stop would drop a char from this cover.
  const visibleReversed = "mix bo ln cd end".split("").reverse();
  const trail = letters.filter((c, i) => i === 0 || c !== letters[i - 1]).map((c) => (c === " " ? " " : c));
  expect(trail.slice(0, visibleReversed.length).join("")).toBe(visibleReversed.join(""));
});

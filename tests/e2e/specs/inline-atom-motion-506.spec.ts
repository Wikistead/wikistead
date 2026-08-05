import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #506 / ADR-024: an INLINE atom (attachment chip, inline image) inside prose is not a place the caret
// rests. It sat in the BLOCK-atom list, which (a) disabled the inline skip, so horizontal motion crawled
// offset-by-offset through the widget's hidden source — one dead press per hidden char, the cursor glued
// to the widget edge — and (b) made blockEntry treat its whole line as a vertical-motion atom, snapping
// j/k landings to the line start even though the line is ordinary prose.
//
// This file used to drive both halves through vim in WYSIWYG. #512 landed 75 minutes after the fix and
// FORCED VIM OFF in WYSIWYG (routes.tsx: vimForcedOff = coarsePointer || displayMode === "wysiwyg"), so
// the combination stopped existing: `gg0` was typed as literal text, two tests failed in setup, and the
// third passed vacuously (its assertion holds trivially once keys are inserted rather than obeyed). It was
// red on every full run for weeks. Each half is now measured where it actually applies — and the two are
// NOT the same mechanism, which the rewrite had to establish rather than assume:
//   (b) column-preserving vertical motion → LIVE, vim j. This is the one that covers #506's predicate:
//       blockEntry filters the block list with isInlineAtom and is gated on neither mode nor vim, and Live
//       is where vim can still be on. Measured: stubbing isInlineAtom to `false` (pre-#506) turns this
//       test red.
//   (a) horizontal crossing → WYSIWYG, ARROW keys. Same user-facing guarantee, DIFFERENT machinery:
//       wysiwygInlineSkip works off the atomic ranges and predates #506, so the same stub leaves these two
//       green (measured). They are kept because nothing else pins the crossing on the surface where it can
//       still be reached — but they are not #506 coverage, and reading them as such would be the vacuous
//       kind of green this rewrite exists to remove.
// #506's remaining half — the vim fat-cursor nudge in WYSIWYG — is unreachable while #512 stands, so
// NOTHING pins it and nothing can: there is no vim in WYSIWYG to drive it.
// Real Chromium + real keys ([[real-dom-e2e-for-layout-motion]]).

const CHIP_LINE = "ab [doc.pdf](wks-attachment:aaaabbbb-1111-2222-3333-444455556666) cd";
const IMG_LINE = "xx ![pic](wks-attachment:aaaabbbb-1111-2222-3333-444455556666) yy";

const MODE = { live: 0, wysiwyg: 3 } as const;

async function setup(page: Page, body: string, mode: keyof typeof MODE, vim: boolean) {
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(body);
  await sleep(600);
  if (vim) {
    await page.getByTestId("vim-toggle").click();
    await sleep(400);
  }
  await page.locator("[role=radiogroup] [role=radio]").nth(MODE[mode]).click();
  await sleep(400);
  await page.locator("[data-pane=preview] .cm-content").focus();
  await sleep(200);
}

const head = (page: Page) => page.evaluate(() => (window as unknown as { __lpSel?: { head: number } }).__lpSel?.head ?? -1);

async function pressAndHead(page: Page, key: string): Promise<number> {
  await page.keyboard.press(key);
  await sleep(180);
  return head(page);
}

for (const [name, line, marker] of [
  ["attachment chip", CHIP_LINE, "[doc.pdf"],
  ["inline image", IMG_LINE, "!["],
] as const) {
  test(`#506: an arrow crosses the ${name} in ONE press (never resting inside the hidden range)`, async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await openScratch(page, `atom506-${Date.now()}`);
    await setup(page, `${line}\n`, "wysiwyg", false);
    const from = line.indexOf(marker);
    const to = line.indexOf(")") + 1; // the atom's source range in the (single-line) doc

    // A plain editing key rather than a vim motion: this surface has no vim, which is the point of the
    // rewrite. Ctrl+Home, not Home — the doc ends in a newline, so after the mode switch the caret sits on
    // the empty last line and Home would only take it to THAT line's start (measured: head stayed at 66).
    await page.keyboard.press("Control+Home");
    await sleep(250);
    expect(await head(page), "the caret starts at the document start").toBe(0);

    // Walk the line: the atom must be crossed in ONE step, and the caret must NEVER rest strictly inside
    // its hidden range (each press either moves within visible text or jumps the whole range).
    const seq: number[] = [];
    for (let i = 0; i < 8; i++) seq.push(await pressAndHead(page, "ArrowRight"));
    const crossIdx = seq.findIndex((h, i) => (i === 0 ? 0 : seq[i - 1]!) < from && h >= to);
    // pre-fix: the crawl produced heads 3,4,5,… (inside the range) and no single-step cross exists
    expect(seq.some((h) => h > from && h < to), `no press rests inside the atom (${JSON.stringify(seq)})`).toBe(false);
    expect(crossIdx, `one press crosses from before the atom to after it (${JSON.stringify(seq)})`).toBeGreaterThanOrEqual(0);

    // and the way back is symmetric
    const back: number[] = [];
    for (let i = 0; i < 8; i++) back.push(await pressAndHead(page, "ArrowLeft"));
    expect(back.some((h) => h > from && h < to), `nothing rests inside the atom on the way back (${JSON.stringify(back)})`).toBe(false);
    expect(back[back.length - 1], "and it returns to the line start").toBe(0);
  });
}

test("#506: vim j onto an inline-atom line keeps its column (the line is prose, not a block atom)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `atom506-j-${Date.now()}`);
  // Live, because #512 leaves no vim in WYSIWYG — and blockEntry, the thing under test, reads neither the
  // mode nor vim, so Live measures it just as well.
  await setup(page, `intro line\n${CHIP_LINE}\n`, "live", true);
  await page.keyboard.press("Escape"); // into vim NORMAL
  await sleep(200);

  await page.keyboard.type("gg");
  await sleep(200);
  const atStart = await head(page);
  expect(atStart, "vim is actually driving — gg moved the caret rather than typing 'gg'").toBe(0);

  await page.keyboard.type("$"); // end of "intro line" (col 9)
  await sleep(200);
  const j = await pressAndHead(page, "j");
  const lineFrom = "intro line\n".length;
  // pre-fix, blockEntry treated the chip's line as a block atom and snapped the landing to the line
  // START; the line is ordinary prose, so vim's column-preserving j must land past its first char.
  expect(j, "j does not snap to the line start").toBeGreaterThan(lineFrom);
});

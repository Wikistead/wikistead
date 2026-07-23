import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #506 / ADR-024: an INLINE atom (attachment chip, inline image) inside prose must be crossed by vim
// h/l in ONE press — the widget's hidden source range is skipped whole, like any hidden inline run.
// Before the fix, inline atoms sat in the BLOCK-atom list, which disabled the vim WYSIWYG nudge for
// them, so h/l crawled offset-by-offset through the hidden range: measured pre-fix, `l` from the char
// before the chip produced head = 3,4,5,… (one dead press per hidden char, the cursor visually stuck
// on the widget edge). Post-fix the same press jumps from→to in one step. WYSIWYG (markers never
// reveal → the widget is always rendered); Live reveals the raw source under the caret, so the inline
// crossing problem is WYSIWYG-specific. Real Chromium + real keys ([[real-dom-e2e-for-layout-motion]]).

const CHIP_LINE = "ab [doc.pdf](wks-attachment:aaaabbbb-1111-2222-3333-444455556666) cd";
const IMG_LINE = "xx ![pic](wks-attachment:aaaabbbb-1111-2222-3333-444455556666) yy";

async function setupWysiwygVim(page: Page, body: string) {
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(body);
  await sleep(600);
  await page.getByTestId("vim-toggle").click();
  await sleep(400);
  await page.locator("[role=radiogroup] [role=radio]").nth(3).click(); // WYSIWYG
  await sleep(400);
  await page.locator("[data-pane=preview] .cm-content").focus();
  await sleep(200);
  await page.keyboard.press("Escape");
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
  test(`#506: vim l/h cross the ${name} in ONE press (never resting inside the hidden range)`, async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await openScratch(page, `atom506-${Date.now()}`);
    await setupWysiwygVim(page, `${line}\n`);
    const from = line.indexOf(marker);
    const to = line.indexOf(")") + 1; // the atom's source range in the (single-line) doc

    await page.keyboard.type("gg0");
    await sleep(250);
    expect(await head(page)).toBe(0);

    // walk the whole line with l — the atom must be crossed in ONE step, and the caret must NEVER
    // rest strictly inside its hidden range (each press either moves within visible text or jumps
    // the whole range).
    const seq: number[] = [];
    for (let i = 0; i < 8; i++) seq.push(await pressAndHead(page, "l"));
    const crossIdx = seq.findIndex((h, i) => (i === 0 ? 0 : seq[i - 1]!) < from && h >= to);
    // pre-fix: the crawl produced heads 3,4,5,… (inside the range) and no single-step cross exists
    expect(seq.some((h) => h > from && h < to), `no press rests inside the atom (${JSON.stringify(seq)})`).toBe(false);
    expect(crossIdx, `one l crosses from before-the-atom to after it (${JSON.stringify(seq)})`).toBeGreaterThanOrEqual(0);

    // and h comes back across in one press too
    const back: number[] = [];
    for (let i = 0; i < 8; i++) back.push(await pressAndHead(page, "h"));
    expect(back.some((h) => h > from && h < to), `h never rests inside the atom (${JSON.stringify(back)})`).toBe(false);
    expect(back[back.length - 1], "h returns to the line start").toBe(0);
  });
}

test("#506: j onto an inline-atom line keeps its column (the line is prose, not a block atom)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `atom506-j-${Date.now()}`);
  await setupWysiwygVim(page, `intro line\n${CHIP_LINE}\n`);

  await page.keyboard.type("gg");
  await sleep(200);
  await page.keyboard.type("$"); // end of "intro line" (col 9)
  await sleep(200);
  const j = await pressAndHead(page, "j");
  const lineFrom = "intro line\n".length;
  // pre-fix, blockEntry treated the chip's line as a block atom and snapped the landing to the line
  // START; the line is ordinary prose, so vim's column-preserving j must land past its first char.
  expect(j, "j does not snap to the line start").toBeGreaterThan(lineFrom);
});

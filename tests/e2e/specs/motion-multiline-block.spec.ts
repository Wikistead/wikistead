import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #141 (comment 697): PIPE tables / PLAIN code blocks / callouts were reported to warp vim
// j/k (skip a line, "1→3") like display math once did. Measured in a REAL browser (happy-dom
// has no layout engine), the caret line steps ONE doc line per key through all three — no
// skip, both directions. This locks that in: a warp would make a sequence non-consecutive.
const head = (page: any) => page.evaluate(() => (window as any).__lpHeadLine);
async function vimOn(page: any) {
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
}
// Press `key` n times from the current caret and return the sequence of head LINE numbers.
async function motionSeq(page: any, key: string, n: number) {
  const seq = [await head(page)];
  for (let i = 0; i < n; i++) { await page.keyboard.press(key); await sleep(90); seq.push(await head(page)); }
  return seq as number[];
}
// A monotonic run (step ±1) has no skipped line — a warp shows up as a gap (e.g. 1→3).
function isConsecutive(seq: number[], dir: 1 | -1) {
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1] + dir) return false;
  return true;
}
// Content shapes (all: line 1 top · a multi-line block · trailing lines) that a j from the
// top and a k from the bottom must traverse one line at a time.
const CASES: Record<string, string> = {
  pipe: "top\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\nmid\nbot\n",
  code: "top\n```js\nconst a = 1\nconst b = 2\nconst c = 3\n```\nmid\nbot\n",
  callout: "top\n:::info\naa\naa\n:::\nmid\nbot\n",
  // #141 comment 735 / #183: DENSE stack (display math + callout + code fence). Multiple block widgets in a
  // row made j skip every other line downstream (5→7→9→…) — the " motion" gated on #183. The #183 clamp
  // (a single j/k moves exactly one line) must make even the dense document step one line at a time.
  dense: "top\n$$x^2$$\n:::info\naa\naa\n:::\n```js\nconst a = 1\n```\nmid\nbot\n",
};

for (const [name, text] of Object.entries(CASES)) {
  test(`#141: vim j/k step one line through a ${name} block (no 1→3 warp)`, async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await openScratch(page, `motion-${name}`);
    await enterEdit(page);
    await page.click("[data-pane=preview] .cm-content");
    await page.keyboard.insertText(text);
    await sleep(500);
    const lines = text.replace(/\n$/, "").split("\n").length;
    await vimOn(page);
    // descend from the very top: every j advances exactly one doc line (no skip).
    await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(120);
    const down = await motionSeq(page, "j", lines - 1);
    expect(isConsecutive(down, 1), `j-seq warped: ${JSON.stringify(down)}`).toBe(true);
    // ascend from the bottom: every k retreats exactly one doc line (the k-warp was the
    // asymmetric one — unbounded upward jump — so this is the important direction).
    await page.keyboard.press("G"); await sleep(120);
    const up = await motionSeq(page, "k", lines - 1);
    expect(isConsecutive(up, -1), `k-seq warped: ${JSON.stringify(up)}`).toBe(true);
  });
}

import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #359 the warp fix (empty-caret-only reveal) had eaten "select → copy the raw source". The
// reconciliation (option B + option A):
//  B: a NON-EMPTY selection FULLY CONTAINED in a revealed block keeps the reveal — dragging inside a
//     revealed mermaid/details selects (and copies) a sub-range of its source. A selection CROSSING the
//     block boundary still never reveals (the #359 vim-warp case; vim-visual-macro-359 pins no-warp).
//  A: copy/cut with an EMPTY caret resting ON a block atom takes the WHOLE block source — CM's
//     copy-the-line default emitted a broken first-line fragment ("```mermaid") in WYSIWYG (symptom 3).
// Real Chromium + real clipboard (context permissions).

const CONTENT = "top line\n\n```mermaid\nflowchart TD\n  A-->B\n```\n\nbottom\n";
const MERMAID_SRC = "```mermaid\nflowchart TD\n  A-->B\n```";

async function newPage(browser: any) {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await openScratch(page, "select-copy-359");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(CONTENT);
  await sleep(700);
  await page.getByText("bottom", { exact: true }).click();
  await sleep(300);
  return page;
}

test("#359-B: a drag INSIDE a revealed block keeps the reveal and copies the sub-range", async ({ browser }) => {
  const page = await newPage(browser);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").first().click(); // caret-in reveal
  await sleep(500);
  const flow = page.locator("[data-pane=preview]").getByText("flowchart TD");
  await expect(flow, "raw revealed").toHaveCount(1);
  const fb = (await flow.boundingBox())!;
  await page.mouse.move(fb.x + 2, fb.y + fb.height / 2);
  await page.mouse.down();
  await page.mouse.move(fb.x + 150, fb.y + fb.height * 1.6, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
  await expect(flow, "still revealed with a non-empty contained selection").toHaveCount(1);
  await page.keyboard.press("Control+c");
  await sleep(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip, "the selected source sub-range was copied").toContain("flowchart TD");
  expect(clip).toContain("A-->B");
  expect(clip, "no fence markers — a SUB-range, not the whole block").not.toContain("```");
});

test("#359-B: a selection CROSSING the block boundary keeps the atom and still copies full source", async ({ browser }) => {
  const page = await newPage(browser);
  const top = (await page.locator("[data-pane=preview]").getByText("top line").boundingBox())!;
  const bot = (await page.locator("[data-pane=preview]").getByText("bottom", { exact: true }).boundingBox())!;
  await page.mouse.move(top.x + 2, top.y + top.height / 2);
  await page.mouse.down();
  await page.mouse.move(bot.x + 40, bot.y + bot.height / 2, { steps: 10 });
  await page.mouse.up();
  await sleep(400);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]"), "atom never de-rendered (no reveal churn)").toHaveCount(1);
  await page.keyboard.press("Control+c");
  await sleep(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip, "the doc slice carries the FULL raw source").toContain(MERMAID_SRC);
  expect(clip).toContain("top line");
  expect(clip).toContain("bottom");
});

test("#359-A (symptom 3): WYSIWYG atom-click + Ctrl+C copies the WHOLE block; paste round-trips", async ({ browser }) => {
  const page = await newPage(browser);
  await page.locator("[role=radiogroup] [role=radio]").nth(3).click(); // WYSIWYG
  await sleep(600);
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").first().click();
  await sleep(300);
  await page.keyboard.press("Control+c");
  await sleep(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip, "the whole block source, not the first line").toBe(MERMAID_SRC);
  // paste after "bottom" and round-trip via Source mode
  await page.getByText("bottom", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+v");
  await sleep(500);
  await page.locator("[role=radiogroup] [role=radio]").nth(1).click(); // Source
  await sleep(500);
  const src = await page.locator("[data-pane=preview] .cm-content").first().innerText();
  expect((src.match(/```mermaid/g) || []).length, "the pasted fence is intact (no broken fragment)").toBe(2);
  expect((src.match(/A-->B/g) || []).length).toBe(2);
});

// #359 details (collapsible directive) could NOT be copied in WYSIWYG — the summary bar's
// mousedown preventDefault toggled collapse WITHOUT placing a caret, so atomClipboard (empty caret on
// the block) never fired and Ctrl+C was a silent no-op. The fix parks a caret on the block on summary
// click in WYSIWYG (never in Live, where a caret-in would flip the panel to raw and destroy the
// click-to-toggle affordance). Callout gets the same mermaid-parity pin (its panel already places the
// caret on click).
const DIRECTIVE_CONTENT = "top line\n\n:::details[More]\nhidden body\n:::\n\n:::note[Hello]\nnote body\n:::\n\nbottom\n";
const DETAILS_SRC = ":::details[More]\nhidden body\n:::";
const NOTE_SRC = ":::note[Hello]\nnote body\n:::";

async function newDirectivePage(browser: any) {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await openScratch(page, "select-copy-359-directive");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(DIRECTIVE_CONTENT);
  await sleep(700);
  await page.getByText("bottom", { exact: true }).click();
  await sleep(300);
  await page.locator("[role=radiogroup] [role=radio]").nth(3).click(); // WYSIWYG
  await sleep(600);
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  return page;
}

test("#359-A: WYSIWYG details click + Ctrl+C copies the WHOLE directive; paste round-trips", async ({ browser }) => {
  const page = await newDirectivePage(browser);
  await page.locator("[data-pane=preview] [data-testid=details-summary-bar]").first().click();
  await sleep(300);
  await page.keyboard.press("Control+c");
  await sleep(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip, "the whole :::details block, not a fragment or a no-op").toBe(DETAILS_SRC);
  // paste after "bottom" and round-trip via Source mode (directive markers intact)
  await page.getByText("bottom", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+v");
  await sleep(500);
  await page.locator("[role=radiogroup] [role=radio]").nth(1).click(); // Source
  await sleep(500);
  const src = await page.locator("[data-pane=preview] .cm-content").first().innerText();
  expect((src.match(/:::details\[More\]/g) || []).length, "the pasted directive is intact").toBe(2);
  expect((src.match(/hidden body/g) || []).length).toBe(2);
});

test("#359-A: WYSIWYG details Ctrl+X cuts the whole directive", async ({ browser }) => {
  const page = await newDirectivePage(browser);
  await page.locator("[data-pane=preview] [data-testid=details-summary-bar]").first().click();
  await sleep(300);
  await page.keyboard.press("Control+x");
  await sleep(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(DETAILS_SRC);
  const src = await page.locator("[data-pane=preview] .cm-content").first().innerText();
  expect(src, "the details block is gone from the doc").not.toContain("hidden body");
  expect(src, "the callout was untouched").toContain("note body");
});

test("#359-A: WYSIWYG callout click + Ctrl+C copies the whole directive (mermaid parity)", async ({ browser }) => {
  const page = await newDirectivePage(browser);
  await page.locator("[data-pane=preview] [data-testid=callout-panel]").first().click();
  await sleep(300);
  await page.keyboard.press("Control+c");
  await sleep(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip, "the whole :::note block").toBe(NOTE_SRC);
});

test("#359-A: Ctrl+X on an atom cuts the whole block (source on the clipboard, block gone)", async ({ browser }) => {
  const page = await newPage(browser);
  // WYSIWYG: the block never reveals, so the caret genuinely RESTS on the atom (in Live a caret-in
  // reveals the raw source and Ctrl+X keeps CM's normal cut-the-line text editing — that's correct).
  await page.locator("[role=radiogroup] [role=radio]").nth(3).click();
  await sleep(600);
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").first().click();
  await sleep(400);
  await page.keyboard.press("Control+x");
  await sleep(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(MERMAID_SRC);
  const src = await page.locator("[data-pane=preview] .cm-content").first().innerText();
  expect(src, "the block is gone from the doc").not.toContain("flowchart");
  expect(src).toContain("top line");
  expect(src).toContain("bottom");
});

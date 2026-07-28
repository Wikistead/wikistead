import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #549: without vim there was NO way to take a block macro's full Markdown source. Ctrl+C on a parked
// atom (atomClipboard, #359) exists but Live-mode reveal makes the parked state mouse-unreachable; the
// fence header's copy button takes the CONTENT only. The fix: a right-click "Copy block" entry that
// resolves the innermost macro at the click (rendered or revealed, any depth) and copies its canonical
// source — fence/::: markers included (Open formats). Read-only: the doc must not change by one byte.
// Real Chromium (clipboard + CM tooltip layer).

const FENCE = "```mermaid\ngraph TD; A-->B;\n```";
const NOTE = ":::note\nAAA note\n:::";

test("#549: right-click Copy block takes the whole fence source; the doc is untouched", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await openScratch(page, `bc549-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(`top\n\n${FENCE}\n\nbot\n`);
  await sleep(1200);
  const before = await page.locator("[data-pane=preview] .cm-content").innerText();

  await page.locator("[data-testid=macro-mermaid]").first().click({ button: "right" });
  await sleep(300);
  const entry = page.getByTestId("ctx-item-copyblock");
  await expect(entry, "the Copy block entry appears on a macro block").toBeVisible();
  await entry.dispatchEvent("mousedown"); // the menu acts on mousedown (see context-menu.ts item())
  await sleep(300);
  expect(await page.evaluate(() => navigator.clipboard.readText()), "canonical source incl. the fence markers").toBe(FENCE);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText(), "copy is read-only").toBe(before);
});

test("#549: on a NESTED macro the innermost block is copied — not the whole container", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await openScratch(page, `bc549n-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(`top\n\n::::columns\n:::column\n${NOTE}\n:::\n:::column\nBBB text\n:::\n::::\n\nbot\n`);
  await sleep(1200);
  await page.getByText("bot").click(); // caret away → the container renders as a widget
  await sleep(300);

  await page.getByText("AAA note").click({ button: "right" });
  await sleep(300);
  const entry = page.getByTestId("ctx-item-copyblock");
  await expect(entry).toBeVisible();
  await entry.dispatchEvent("mousedown");
  await sleep(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip, "the innermost note, fences included").toBe(NOTE);
  expect(clip, "NOT the container").not.toContain("columns");
});

test("#549: non-vim Ctrl+C on a clicked nested macro copies the whole block source (atomClipboard in the island)", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await openScratch(page, `bc549k-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(`top

::::columns
:::column
${NOTE}
:::
:::column
BBB text
:::
::::

bot
`);
  await sleep(1200);
  await page.getByText("bot").click();
  await sleep(300);
  await page.getByText("AAA note").click(); // enters the slot island; the note is the selected atom inside it
  await sleep(500);
  await page.keyboard.press("Control+c");
  await sleep(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip, "the whole nested block, fences included").toBe(NOTE);
});

// The fence header's own CONTENT-copy button is deliberately untouched by #549 (different job);
// its pin lives in public-page.spec.ts (`.cm-lp-code-copy` on the public surface).

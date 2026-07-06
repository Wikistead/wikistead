import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #223: pasting a URL in the body auto-linkifies to Markdown [url](url) AND renders as a clickable link;
// a dangerous scheme stays plain. Uses a REAL clipboard + Ctrl+V (not a synthetic ClipboardEvent) and
// asserts the RENDERED result (the reviewer's exact critique: prove the real paste path + insertion +
// rendering, not just the pure helper).

async function ctx(browser: any) {
  const c = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  return c.newPage();
}
async function realPaste(page: any, text: string) {
  await page.evaluate((t: string) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("Control+v");
  await sleep(300);
}
async function caretToTop(page: any) { // click line 1 ("anchor") to move the caret off the pasted line 2
  await page.locator("[data-pane=preview] .cm-line").first().click();
  await sleep(300);
}
const linkOf = (page: any) => page.evaluate(() => {
  const l = document.querySelector("[data-pane=preview] .cm-lp-link") as HTMLElement | null;
  return l ? { text: l.textContent, href: l.getAttribute("data-href") } : null;
});
const rawText = (page: any) => page.locator("[data-pane=preview] .cm-content").innerText();

test("#223: pasting an http(s) URL inserts [url](url) that renders as a clickable link (not blank)", async ({ browser }) => {
  const page = await ctx(browser);
  await openScratch(page, "paste-url");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("anchor\n"); // line 1, caret on line 2
  await realPaste(page, "https://example.com/x");
  expect(await rawText(page)).toContain("[https://example.com/x](https://example.com/x)"); // source stays Markdown
  await caretToTop(page);
  const link = await linkOf(page);
  expect(link?.href).toBe("https://example.com/x"); // rendered as a clickable link…
  expect(link?.text).toBe("https://example.com/x"); // …showing the URL (NOT blank — the #223 fix)
});

test("#223: pasting a javascript: URL does NOT linkify (stays plain text)", async ({ browser }) => {
  const page = await ctx(browser);
  await openScratch(page, "paste-js");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("anchor\n");
  await realPaste(page, "javascript:alert(1)");
  const text = await rawText(page);
  expect(text).toContain("javascript:alert(1)"); // present as plain text
  expect(text).not.toContain("](javascript:"); // but NEVER as a link target
  await caretToTop(page);
  expect(await linkOf(page)).toBeNull(); // and no clickable link produced
});

test("#223: selected text + pasted URL wraps the selection as the link anchor", async ({ browser }) => {
  const page = await ctx(browser);
  await openScratch(page, "paste-sel");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("anchor\n");
  await page.keyboard.type("my site");
  await page.keyboard.press("Shift+Home"); // select "my site" on line 2
  await realPaste(page, "https://example.com");
  expect(await rawText(page)).toContain("[my site](https://example.com)");
  await caretToTop(page);
  const link = await linkOf(page);
  expect(link?.text).toBe("my site");
  expect(link?.href).toBe("https://example.com");
});

// #223 comment 875: with vim ON, `<C-v>` is a vim command (blockwise-visual) that consumes the Ctrl+V keydown
// and preventDefaults it, so the browser never fires the native paste event — Ctrl+V neither pasted nor
// linkified in vim mode. The capture keydown now takes plain Ctrl+V back for system paste when vim is enabled,
// so linkify works in vim ON just like vim OFF, in BOTH normal and insert mode.
test("#223: vim ON, Ctrl+V URL linkifies in normal AND insert mode", async ({ browser }) => {
  const page = await ctx(browser);
  await openScratch(page, "paste-vim");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.click("[data-pane=preview] .cm-content");

  // NORMAL mode: previously Ctrl+V hit vim's blockwise-visual and no paste event fired (the reported bug).
  await page.keyboard.press("Escape");
  await realPaste(page, "https://example.com/n");
  expect(await rawText(page)).toContain("[https://example.com/n](https://example.com/n)");

  // INSERT mode: also linkifies (vim does not bind <C-v> in insert).
  await page.keyboard.press("i");
  await page.keyboard.type("\n");
  await realPaste(page, "https://example.com/v");
  expect(await rawText(page)).toContain("[https://example.com/v](https://example.com/v)");
});

// #223 comment 885: pasting a URL onto a SELECTED (non-editing) RichUI cell must drop it IN the cell (the
// Excel select-then-paste), NOT at the table's atom boundary. The CM-body handler bypasses when the table
// island has focus; the table's own paste handler starts editing the active cell with the linkified content.
test("#223 comment 885: URL paste onto a selected cell lands in the cell, not the atom boundary", async ({ browser }) => {
  const page = await ctx(browser);
  await openScratch(page, "paste-cell");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| A | B |\n| --- | --- |\n| 1 | 2 |\n\nbelow\n");
  await sleep(300);
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
  await sleep(150);
  await page.keyboard.press("Control+Enter"); // pipe x Live RichUI opt-in
  await expect(page.getByTestId("table-edit")).toBeVisible();

  const cell = page.getByTestId("table-edit").locator("td").first(); // body cell "1"
  await cell.click(); // single click = SELECT (non-edit)
  await sleep(150);
  await page.evaluate(() => navigator.clipboard.writeText("https://example.com/cell"));
  await page.keyboard.press("Control+v");
  await sleep(250);

  // the URL is linkified INTO the cell (rendered as a link), not inserted at the table edge.
  await expect(cell.locator("a")).toHaveAttribute("href", "https://example.com/cell");
  await page.keyboard.press("Enter"); // commit the cell
  await sleep(150);
  await page.keyboard.press("Escape"); // exit edit mode -> static render
  await sleep(300);
  // the committed cell renders the link INSIDE the table (WYSIWYG); it did NOT leak to a stray line below.
  const tbl = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(tbl.locator("td").first().locator("a")).toHaveAttribute("href", "https://example.com/cell");
  // the paragraph below the table is still just "below" (no stray top-level linkified URL was inserted).
  const below = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(below).not.toContain("example.com/cell\nbelow"); // not dropped right before "below"
});

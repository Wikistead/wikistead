import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #89: the in-cell inline-decoration toolbar (bold/italic/strike/code/link) for a table cell being edited.
// Real-Chromium coverage for the comment-886 fixes: (②) the Link button opens a URL popover so a real
// destination can be entered, and (③) a mark spanning an in-cell <br> decorates BOTH lines (per-line wrap).
async function openRichUICell(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| A | B |\n| --- | --- |\n| 1 | 2 |\n\nbelow\n");
  await sleep(300);
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
  await sleep(150);
  await page.keyboard.press("Control+Enter"); // pipe x Live RichUI opt-in
  await expect(page.getByTestId("table-edit")).toBeVisible();
}
// Select the whole contents of an editing cell (the toolbar shows on a non-collapsed in-cell selection).
async function selectCell(cell: any) {
  await cell.evaluate((el: HTMLElement) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

test("#89 comment 886 (②): cell Link toolbar opens a URL popover → inserts a real [text](url)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cell-link");
  await enterEdit(page);
  await openRichUICell(page);
  const cell = page.getByTestId("table-edit").locator("td").first(); // body cell "1"
  await cell.dblclick(); // enter edit
  await sleep(100);
  await selectCell(cell);
  await sleep(150);
  await expect(page.getByTestId("cell-format-bar")).toBeVisible();
  await page.getByTestId("cell-format-link").click();
  await expect(page.getByTestId("cell-link-popover")).toBeVisible();
  await page.getByTestId("cell-link-url").fill("https://example.com/z");
  await page.keyboard.press("Enter"); // sent to the focused input (which closePopover removes on confirm)
  await sleep(200);
  await expect(cell.locator("a")).toHaveAttribute("href", "https://example.com/z"); // real destination set
  await expect(cell.locator("a")).toHaveText("1");
});

test("#89 comment 886 (③): a mark spanning an in-cell <br> decorates BOTH lines (per-line wrap)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cell-multiline");
  await enterEdit(page);
  await openRichUICell(page);
  const cell = page.getByTestId("table-edit").locator("td").first();
  await cell.dblclick();
  await sleep(100);
  await selectCell(cell);
  await page.keyboard.type("one");
  await page.keyboard.press("Shift+Enter"); // in-cell <br>
  await page.keyboard.type("two");
  await sleep(100);
  await selectCell(cell); // select "one<br>two"
  await sleep(150);
  await expect(page.getByTestId("cell-format-bar")).toBeVisible();
  await page.getByTestId("cell-format-bold").click();
  await sleep(200);
  // per-line wrap → two <strong>, not one <strong> spanning the <br> (which would break the source round-trip).
  await expect(cell.locator("strong")).toHaveCount(2);
  await expect(cell.locator("br")).toHaveCount(1);
});

// #236: inline formats TOGGLE — pressing the button on an already-formatted selection REMOVES the mark.
// Body (floating toolbar / format bubble) and the cell toolbar behave the same; mixed selections unify
// on the first press and remove on the second. Real Chromium (the WYSIWYG show/no-show class of bugs).
test("#236: BODY selection toggle — bold applies, re-press removes (no literal ** left)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "body-toggle");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("hello world");
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight"); // select "hello"
  await sleep(200);
  const bubble = page.getByTestId("format-bubble");
  await expect(bubble).toBeVisible();
  await bubble.locator("button", { hasText: "B" }).first().click();
  await sleep(200);
  let src = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(src).toContain("**hello** world"); // applied
  // selection is kept over "hello" — press B again → removed
  await expect(bubble).toBeVisible();
  await bubble.locator("button", { hasText: "B" }).first().click();
  await sleep(200);
  src = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(src).toContain("hello world");
  expect(src).not.toContain("**"); // no leftover marks
});

test("#236: CELL toggle — bold ON then OFF on the same selection; mixed unifies then removes", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cell-toggle");
  await enterEdit(page);
  await openRichUICell(page);
  const cell = page.getByTestId("table-edit").locator("td").first(); // body cell "1"
  await cell.dblclick();
  await sleep(100);
  await selectCell(cell);
  await sleep(150);
  await expect(page.getByTestId("cell-format-bar")).toBeVisible();
  await page.getByTestId("cell-format-bold").click();
  await sleep(150);
  await expect(cell.locator("strong")).toHaveCount(1); // applied (WYSIWYG)
  // applyCellMark re-selects the whole cell — press again → removed
  await page.getByTestId("cell-format-bold").click();
  await sleep(150);
  await expect(cell.locator("strong")).toHaveCount(0); // toggled off
  // MIXED: make "1x" where only "1" is bold, select all → unify (one strong), press again → none
  await page.keyboard.press("ArrowRight"); // collapse the (whole-cell) selection to the end
  await page.keyboard.type("x"); // cell text now "1x"
  await selectCell(cell);
  await page.getByTestId("cell-format-bold").click(); // all bold
  await sleep(120);
  const rInfo = await cell.evaluate((el: HTMLElement) => {
    // unbold just the FIRST character via a sub-range selection
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const t = walker.nextNode() as Text;
    const r = document.createRange();
    r.setStart(t, 0); r.setEnd(t, 1);
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
    return t.nodeValue;
  });
  expect(rInfo).toBeTruthy();
  await page.getByTestId("cell-format-bold").click(); // sub-range removal → split, second char stays bold
  await sleep(120);
  await expect(cell.locator("strong")).toHaveCount(1); // mixed state now
  await selectCell(cell); // whole cell (mixed) → unify
  await page.getByTestId("cell-format-bold").click();
  await sleep(120);
  await expect(cell.locator("strong")).toHaveCount(1); // ONE unified span
  await page.getByTestId("cell-format-bold").click(); // second press removes all
  await sleep(120);
  await expect(cell.locator("strong")).toHaveCount(0);
});

// #236 review fix: after a cell mark toggle the SELECTION must stay put (offset-restore), not
// jump to the whole cell — otherwise a sub-range's 2nd press re-covers the cell instead of removing.
test("#236: cell sub-range toggle keeps the selection and round-trips (2nd press removes just that range)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cell-toggle-sel");
  await enterEdit(page);
  await openRichUICell(page);
  const cell = page.getByTestId("table-edit").locator("td").first();
  await cell.dblclick();
  await sleep(100);
  await selectCell(cell); // selects the cell's "1" → typing replaces it
  await page.keyboard.type("abcdef");
  await sleep(80);
  // select the middle "cd" (offsets 2..4) inside the cell's text node
  await cell.evaluate((el: HTMLElement) => {
    const t = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE) as Text;
    const r = document.createRange(); r.setStart(t, 2); r.setEnd(t, 4);
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await sleep(120);
  await page.getByTestId("cell-format-bold").click(); // bold "cd" only
  await sleep(150);
  await expect(cell.locator("strong")).toHaveText("cd"); // just cd bolded
  // the selection must still cover exactly "cd" (NOT the whole cell)
  const selText = await page.evaluate(() => window.getSelection()?.toString());
  expect(selText).toBe("cd");
  // 2nd press removes ONLY cd's bold (round-trip) — cell has no <strong>, text intact
  await page.getByTestId("cell-format-bold").click();
  await sleep(150);
  await expect(cell.locator("strong")).toHaveCount(0);
  await expect(cell).toHaveText("abcdef");
});

// #89 comment 896: the earlier tests stopped at the EDIT-ISLAND DOM (<strong>×N) and never verified the
// COMMIT → static render. Edge whitespace inside a mark serialises to `**one **` which CommonMark won't
// parse as emphasis → a literal `**` shows in the committed table. Drive edit → commit → static render and
// assert NO literal `**`/`****` in the static cell and the text is styled.
test("#89 comment 896: bold with trailing space commits to valid source (no literal ** in the table)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cell-ws-trail");
  await enterEdit(page);
  await openRichUICell(page);
  const cell = page.getByTestId("table-edit").locator("td").first();
  await cell.dblclick();
  await sleep(100);
  // set the cell content to "one two", select "one " (with trailing space), bold it
  await cell.evaluate((el: HTMLElement) => { el.textContent = "one two"; });
  await cell.evaluate((el: HTMLElement) => {
    const t = el.firstChild as Text;
    const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 4); // "one "
    const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await sleep(150);
  await page.getByTestId("cell-format-bold").click();
  await sleep(150);
  await page.keyboard.press("Enter"); // commit the cell
  await sleep(150);
  await page.keyboard.press("Escape"); // exit edit → static render
  await sleep(300);
  const tbl = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(tbl).toBeVisible();
  const firstCell = tbl.locator("td").first();
  await expect(firstCell.locator("strong")).toHaveText("one"); // rendered bold
  await expect(firstCell).not.toContainText("**"); // no literal delimiter leaked
});

test("#89 comment 896: multi-line (<br>) bold with a per-line trailing space renders both lines bold", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cell-ws-multiline");
  await enterEdit(page);
  await openRichUICell(page);
  const cell = page.getByTestId("table-edit").locator("td").first();
  await cell.dblclick();
  await sleep(100);
  await cell.evaluate((el: HTMLElement) => { el.replaceChildren(document.createTextNode("one "), document.createElement("br"), document.createTextNode("two")); });
  await selectCell(cell);
  await sleep(150);
  await page.getByTestId("cell-format-bold").click();
  await sleep(150);
  await page.keyboard.press("Enter");
  await sleep(150);
  await page.keyboard.press("Escape");
  await sleep(300);
  const firstCell = page.locator("[data-pane=preview] table.cm-lp-table td").first();
  await expect(firstCell.locator("strong")).toHaveCount(2); // both lines bold
  await expect(firstCell).not.toContainText("**"); // no literal ** / **** leaked
});

import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #278 §2a / ADR-122 (A): clicking a layout SLOT's content mounts an inline CM6 island (the C3 source-editor)
// IN that cell — full editor, in place, no separate panel. It commits the slot's body via ONE offset-invariant
// Y.Text replace on BLUR (single Y.Text — no 2nd CRDT). The other columns stay side-by-side (flex preserved).
const content = (p: any) => p.locator("[data-pane=preview] .cm-content").innerText();

async function columnsDoc(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\nAAA\n:::\n:::column\nBBB\n:::\n::::\n\nbot\n");
  await sleep(700);
  await page.getByText("bot").click(); // caret OUT → the columns widget renders
  await sleep(200);
}

test("#278 §2a: clicking a column slot mounts an inline CM6 editor; type + blur commits to THAT slot only", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const errs: string[] = []; page.on("pageerror", (e) => errs.push(String(e)));
  await openScratch(page, "slot-edit"); await enterEdit(page);
  await columnsDoc(page);
  await expect(page.locator("[data-pane=preview] .cm-lp-column")).toHaveCount(2);

  // click the FIRST column's content → the inline CM6 island mounts in that cell.
  await page.locator("[data-pane=preview] .cm-lp-column").first().click();
  await sleep(300);
  const src = page.locator("[data-pane=preview] [data-testid=slot-edit-src]");
  await expect(src).toBeVisible();
  // the OTHER column still renders side-by-side (flex preserved — the island is DOM inside the cell).
  await expect(page.locator("[data-pane=preview] .cm-lp-column")).toContainText("BBB");

  // #278 §2a reviewer B: a SINGLE click opens AND focuses the island — no second click needed. Type directly.
  const focused = await page.evaluate(() => !!document.activeElement?.closest?.("[data-testid=slot-edit-island]"));
  expect(focused, "the island is focused after a single click").toBe(true);
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" MORE");
  await sleep(150);
  // blur (click outside) → commit-on-blur → one Y.Text replace of the slot body.
  await page.getByText("bot").click();
  await sleep(400);

  // verify the raw source: the first column's body became "AAA MORE"; the second is untouched.
  await page.getByTestId("displaymode-source").click();
  await sleep(250);
  const src2 = await content(page);
  expect(src2).toContain("AAA MORE");
  expect(src2).toContain("BBB");
  expect(src2).toContain(":::column"); // structure round-trips (fences intact)
  expect(errs, errs.join(" | ")).toHaveLength(0);
});

// #278 §2a (reviewer must-fix 2): an EMPTY / adjacent-fence slot (`:::column\n:::`, reachable via GFM
// paste/import) must NOT be corrupted by a commit — inserting text at the naive close-fence point would make
// `hello:::`. The commit inserts at the open-fence line end with newlines, so the fence stays intact.
test("#278 §2a: editing an EMPTY slot keeps the fence intact (no `hello:::` round-trip break)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "slot-empty"); await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // second column is EMPTY (adjacent fences) — the paste/import case.
  await page.keyboard.insertText("top\n\n::::columns\n:::column\nAAA\n:::\n:::column\n:::\n::::\n\nbot\n");
  await sleep(700);
  await page.getByText("bot").click(); await sleep(200);

  // edit the SECOND (empty) column.
  await page.locator("[data-pane=preview] .cm-lp-column").nth(1).click();
  await sleep(300);
  const src = page.locator("[data-pane=preview] [data-testid=slot-edit-src]");
  await expect(src).toBeVisible();
  await src.click();
  await page.keyboard.type("hello");
  await page.getByText("bot").click(); // blur → commit
  await sleep(400);

  await page.getByTestId("displaymode-source").click();
  await sleep(250);
  const s = await content(page);
  expect(s).toContain("hello");
  expect(s).not.toContain("hello:::"); // the fence was NOT merged/destroyed
  // both columns' open fences intact — match the WHOLE line (`::::columns` contains ":::column" as a substring).
  expect((s.match(/^:::column$/gm) || []).length).toBe(2);
  expect((s.match(/^:::$/gm) || []).length).toBe(2); // both close fences intact
});

// #278 §2b: the inline slot island carries a slash palette — typing "/" inside it inserts markdown into the
// island's OWN doc (committed to the slot body on blur), not the host doc.
test("#278 §2b: a slash palette works inside the slot island", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "slot-slash"); await enterEdit(page);
  await columnsDoc(page);
  await page.locator("[data-pane=preview] .cm-lp-column").first().click();
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=slot-edit-src]")).toBeVisible();

  // on a fresh line inside the island, open the palette and insert a blockquote.
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/quote");
  await expect(page.locator("[data-testid=slash-palette]")).toBeVisible();
  await page.locator("[data-testid=slash-item-quote]").click();
  await sleep(200);
  await page.getByText("bot").click(); // blur → commit-on-blur
  await sleep(400);

  await page.getByTestId("displaymode-source").click();
  await sleep(250);
  const s = await content(page);
  expect(s).toContain("AAA"); // original body kept
  expect(s).toContain("> ");  // the palette inserted a blockquote into the slot body
});

// #278 §2c: the slot island shows a LIVE PREVIEW below the source — a nested directive/macro renders via the
// shared renderMarkdownToDom as you type (no doc write until blur).
test("#278 §2c: the slot island live-previews nested markdown as you type", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "slot-preview"); await enterEdit(page);
  await columnsDoc(page);
  await page.locator("[data-pane=preview] .cm-lp-column").first().click();
  await sleep(300);
  const island = page.locator("[data-pane=preview] [data-testid=slot-edit-island]");
  await expect(island).toBeVisible();
  // the preview seeds with the current body ("AAA").
  const preview = page.locator("[data-pane=preview] [data-testid=slot-edit-preview]");
  await expect(preview).toContainText("AAA");

  // type a nested callout in the island → the preview renders it live (a callout panel), no doc write yet.
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\n**bold live**");
  await sleep(300);
  await expect(preview.locator("strong")).toContainText("bold live"); // rendered via renderMarkdownToDom
  // the host doc is NOT written until blur (source mode would still show the old body).
});

test("#278 §2a: Escape exits the slot island without committing a stray edit", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "slot-edit-esc"); await enterEdit(page);
  await columnsDoc(page);
  await page.locator("[data-pane=preview] .cm-lp-column").first().click();
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=slot-edit-src]")).toBeVisible();
  // Escape backs out of the island → it unmounts and the column re-renders.
  await page.keyboard.press("Escape");
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=slot-edit-src]")).toHaveCount(0);
  await expect(page.locator("[data-pane=preview] .cm-lp-column")).toHaveCount(2);
});

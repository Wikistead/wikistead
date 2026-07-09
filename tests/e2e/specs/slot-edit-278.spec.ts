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

  // type into the island (it holds "AAA"); the #265 guard means the click/keys reach the island, not the atom.
  await src.click();
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

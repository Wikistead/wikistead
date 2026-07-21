import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #456 S3: a details body is prose, so it edits on the HOST's surface rather than in a plain
// textarea. That is the whole point of the S1 seam — the body gets the page's own editing behaviour
// (a real caret, vim when vim is on, the slash palette, live preview) instead of each macro
// re-implementing a box, and the macro still never touches the document or the editor.

const docText = (p: Page) => p.evaluate(() => {
  const ed = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
  const view = (ed?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as
    { state: { doc: { toString(): string } } };
  return view.state.doc.toString();
});

async function openDetailsEditor(page: Page) {
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await sleep(200);
  await page.keyboard.press("Control+Enter");
  await sleep(600);
  await expect(page.getByTestId("details-editui")).toBeVisible({ timeout: 8000 });
}

test("#456 S3: the details body edits on the shared surface, not a textarea", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `details456-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More]\noriginal body\n:::\n\nbelow\n");
  await sleep(800);
  await page.getByText("below", { exact: true }).click();
  await sleep(400);

  await openDetailsEditor(page);

  const body = page.getByTestId("details-edit-body");
  await expect(body).toBeVisible();
  // the testid lands on the editable surface itself, exactly where it used to land on the textarea
  expect(await body.evaluate((el) => el.tagName), "a CodeMirror surface, not a <textarea>").not.toBe("TEXTAREA");
  expect(await body.evaluate((el) => el.classList.contains("cm-content")), "…and it really is one").toBe(true);

  // typing goes through the surface and commits to the document on the way out
  await body.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus more");
  await page.getByText("below", { exact: true }).click();
  await sleep(800);

  const doc = await docText(page);
  expect(doc, "the edit landed in the details body").toContain("original body plus more");
  expect(doc, "and the fence head survived").toContain(":::details[More]");
});

test("#456 S3: the shared surface brings the slash palette to a details body", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `details456slash-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More]\nbody\n:::\n\nbelow\n");
  await sleep(800);
  await page.getByText("below", { exact: true }).click();
  await sleep(400);

  await openDetailsEditor(page);
  const body = page.getByTestId("details-edit-body");
  await body.click();
  await page.keyboard.press("End");
  await page.keyboard.type("\n/");
  await sleep(600);

  // the palette is the page's own — a macro that stood up its own textarea could never offer it
  await expect(page.getByTestId("slash-palette"), "the page's slash palette opens inside the details body").toBeVisible({ timeout: 8000 });
  await page.keyboard.press("Escape");
});

// #456 S5: the same for a callout body — it is Markdown too, so it gets the shared surface rather
// than the panel's old textarea. Same seam, no per-macro editor.
test("#456 S5: the callout body edits on the shared surface too", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `callout456-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::warning[Careful]\ncallout body\n:::\n\nbelow\n");
  await sleep(800);
  await page.getByText("below", { exact: true }).click();
  await sleep(400);

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await sleep(200);
  await page.keyboard.press("Control+Enter");
  await sleep(700);

  const body = page.getByTestId("callout-edit-body");
  await expect(body).toBeVisible({ timeout: 8000 });
  expect(await body.evaluate((el) => el.tagName), "a CodeMirror surface, not a <textarea>").not.toBe("TEXTAREA");
  expect(await body.evaluate((el) => el.classList.contains("cm-content"))).toBe(true);

  await body.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" extended");
  await page.getByText("below", { exact: true }).click();
  await sleep(800);

  const doc = await docText(page);
  expect(doc, "the edit landed in the callout body").toContain("callout body extended");
  expect(doc, "and the fence head survived").toContain(":::warning[Careful]");
});

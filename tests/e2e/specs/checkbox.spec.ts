import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const API = "http://dev.localhost:4010";
const content = (p: Page) => p.locator("[data-pane=preview] .cm-content").innerText();
const publishedMd = (p: Page, pageId: string) =>
  p.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/pages/${id}/published`, { headers: { Authorization: "Bearer dev-token" } });
    return ((await r.json()) as { publishedMd: string | null }).publishedMd;
  }, { api: API, id: pageId });
const publish = (p: Page, pageId: string) =>
  p.evaluate(async ({ api, id }) => {
    await fetch(`${api}/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, id: pageId });

// ADR-019: GFM task items render as real checkboxes. On the EDITABLE surface a click
// flips the `[ ]`/`[x]` char directly in the draft (a normal Y.Text edit).
test("edit mode: a task item renders as a checkbox; clicking it flips the draft", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cb-edit");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("- [ ] alpha\nbeta"); // cursor ends on line 2 → line 1 not revealed

  const box = page.getByTestId("task-checkbox");
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();

  await box.click();
  await sleep(120);
  await expect(box).toBeChecked(); // the widget reflects the doc → the char became [x]

  // confirm the underlying markdown: move the caret onto the line to reveal raw source
  await page.keyboard.press("ArrowUp");
  await sleep(80);
  expect(await content(page)).toContain("[x] alpha");
});

// ADR-019: on the read-only PUBLISHED surface, an edit-capable viewer can still tick a
// box — it persists into published_md via the no-revision endpoint (the client flips the
// live draft over its collab connection first). No need to enter edit mode.
test("view mode: an edit-capable viewer toggles a checkbox; it persists to published_md", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await openScratch(page, "cb-view");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("- [ ] ship it");
  await sleep(200);
  await publish(page, pageId); // published_md == draft (not dirty)
  expect(await publishedMd(page, pageId)).toContain("- [ ] ship it");

  // back to the rendered (published, read-only) view ("Done")
  await page.click("[data-testid=view-toggle]");
  await sleep(400);

  const box = page.getByTestId("task-checkbox");
  await expect(box).toBeVisible();
  await expect(box).toBeEnabled(); // edit-capable + not dirty → interactive
  await box.click();

  // the no-revision endpoint folds the flip into the published snapshot
  await expect.poll(() => publishedMd(page, pageId), { timeout: 5000 }).toContain("- [x] ship it");
});

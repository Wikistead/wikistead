import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// Design-5 (ADR-019 D6/D7): the history panel's "Compare" opens a near-fullscreen
// SPLIT diff (DiffModal) — left = revision, right = current published. It is an overlay,
// so the editor stays mounted and presence/collab are untouched. Because checkbox state
// is text (D7), a view-mode toggle (updates published_md, NO revision per D1/D2) shows
// up as a "change" row with old on the left and new on the right; restore rewinds it.
const publishedMd = (p: Page, id: string) =>
  p.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/pages/${id}/published`, { headers: { Authorization: "Bearer dev-token" } });
    return ((await r.json()) as { publishedMd: string | null }).publishedMd ?? "";
  }, { api: API, id });
const revisionCount = (p: Page, id: string) =>
  p.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/pages/${id}/revisions`, { headers: { Authorization: "Bearer dev-token" } });
    // #623: the history is paged; this spec compares counts across a publish, and both readings come
    // from the same first page of 100.
    return ((await r.json()) as { revisions: unknown[] }).revisions.length;
  }, { api: API, id });
const publish = (p: Page, id: string) =>
  p.evaluate(async ({ api, id }) => {
    await fetch(`${api}/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, id });

test("history split diff: a checkbox flip shows as a left/right change row; overlay keeps the editor mounted; restore keeps live task progress (#316)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await openScratch(page, "hist-diff");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("- [ ] task one");
  await sleep(3500); // collab debounce so the publish snapshots this draft
  await publish(page, pageId); // revision 1 holds "- [ ] task one"
  await expect.poll(() => revisionCount(page, pageId), { timeout: 15_000 }).toBe(1);

  // view mode → tick the box (updates published_md, NO new revision — ADR-019 D1/D2)
  await page.click("[data-testid=view-toggle]");
  await sleep(400);
  await page.getByTestId("task-checkbox").click();
  await expect.poll(() => publishedMd(page, pageId), { timeout: 5000 }).toContain("- [x] task one");
  expect(await revisionCount(page, pageId)).toBe(1); // the tick created no revision

  // open History → Compare → the split modal
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=history-toggle]");
  await page.getByTestId("revision-diff").first().click();
  await expect(page.getByTestId("diff-modal")).toBeVisible();

  // split view: the checkbox flip is one "change" row — old `[ ]` on the left, new `[x]`
  // on the right (side-by-side, not inline)
  const changeRow = page.locator("[data-testid=diff-row][data-difftype=change]");
  await expect(changeRow.locator("[data-side=left]")).toContainText("- [ ] task one");
  await expect(changeRow.locator("[data-side=right]")).toContainText("- [x] task one");

  // collab-safety proxy: the modal is an OVERLAY — the editor surface is still mounted
  // underneath (not unmounted/replaced), so the collab connection is never dropped.
  await expect(page.locator("[data-pane=preview] .cm-content")).toBeAttached();

  // close the overlay, then restore revision 1. #316 / ADR-123: restoring the BODY must NOT silently revert
  // live task PROGRESS — the task composition is unchanged (one "task one"), so the CURRENT checkbox state ([x])
  // is overlaid onto the restored prose. So the tick is KEPT (published stays "- [x]"), not rewound to "- [ ]".
  // (The prose-rewind aspect of restore is covered by the D-series revision tests; here the only diff is the
  // checkbox, which #316 deliberately preserves.)
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("diff-modal")).toHaveCount(0);
  await page.getByTestId("revision-restore").first().click();
  await page.locator("[data-testid=confirm-dialog] [data-testid=confirm-restore]").click();
  // The restore completes (a new revision is inserted → count 2) and preserves the live task progress.
  await expect.poll(() => revisionCount(page, pageId), { timeout: 10_000 }).toBe(2);
  expect(await publishedMd(page, pageId)).toContain("- [x] task one"); // #316: task progress kept, not reverted
});

import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// Design-5 (ADR-019 D6/D7): the history panel can diff a revision against the current
// published snapshot. Because checkbox state is text (D7), a view-mode toggle — which
// updates published_md WITHOUT a revision (D1/D2) — shows up in the diff as a changed
// line, and a restore rewinds the checkbox with the body.
const API = "http://dev.localhost:4010";
const publishedMd = (p: Page, id: string) =>
  p.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/pages/${id}/published`, { headers: { Authorization: "Bearer dev-token" } });
    return ((await r.json()) as { publishedMd: string | null }).publishedMd ?? "";
  }, { api: API, id });
const revisionCount = (p: Page, id: string) =>
  p.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/pages/${id}/revisions`, { headers: { Authorization: "Bearer dev-token" } });
    return ((await r.json()) as unknown[]).length;
  }, { api: API, id });
const publish = (p: Page, id: string) =>
  p.evaluate(async ({ api, id }) => {
    await fetch(`${api}/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, id });

test("history diff surfaces a checkbox change; the toggle made no revision; restore rewinds it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await openScratch(page, "hist-diff");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("- [ ] task one");
  await sleep(3500); // collab debounce, so the publish snapshots this draft
  await publish(page, pageId); // revision 1 holds "- [ ] task one"
  await expect.poll(() => revisionCount(page, pageId), { timeout: 15_000 }).toBe(1);

  // view mode → tick the box (updates published_md, NO new revision — ADR-019 D1/D2)
  await page.click("[data-testid=view-toggle]");
  await sleep(400);
  await page.getByTestId("task-checkbox").click();
  await expect.poll(() => publishedMd(page, pageId), { timeout: 5000 }).toContain("- [x] task one");
  expect(await revisionCount(page, pageId)).toBe(1); // the tick created no revision

  // open History → Compare the revision against the current published snapshot
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=history-toggle]");
  await expect(page.getByTestId("history-panel")).toBeVisible();
  await page.getByTestId("revision-diff").first().click();
  await expect(page.getByTestId("history-diff")).toBeVisible();

  // the checkbox flip shows as a removed `[ ]` line and an added `[x]` line
  const del = page.locator("[data-testid=diff-body] [data-difftype=del]");
  const add = page.locator("[data-testid=diff-body] [data-difftype=add]");
  await expect(del).toContainText("- [ ] task one");
  await expect(add).toContainText("- [x] task one");

  // restore the revision → published rewinds to the unchecked state (D7)
  await page.getByTestId("diff-back").click();
  await page.getByTestId("revision-restore").first().click();
  await page.locator("[data-testid=confirm-dialog] [data-testid=confirm-restore]").click();
  await expect.poll(() => publishedMd(page, pageId), { timeout: 10_000 }).toContain("- [ ] task one");
});

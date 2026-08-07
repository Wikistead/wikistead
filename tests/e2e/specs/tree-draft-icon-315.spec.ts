import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// #315: the sidebar draft indicator is the file icon itself (FilePen replaces FileText) plus a
// dimmed title — the old text pill (tree-draft-badge) is gone. Three row states stay distinct:
//   draft (never published)      → FilePen icon + dimmed title, no dot
//   published + unpublished edit → FileText + accent dot, NOT the draft icon
//   published clean              → FileText only
// Real browser: the assertions are computed colors and rendered DOM, not class names.
const publish = (p: Page, pageId: string) =>
  p.evaluate(async ({ api, id }) => {
    await fetch(`${api}/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, id: pageId });

const selectedRow = (page: Page) => page.locator("[data-testid=tree-page][data-selected]").first();

test("#315 draft row: FilePen icon + tooltip + dimmed title, no text pill, no dot", async ({ page }) => {
  await openScratch(page, "Draft Icon Probe"); // fresh page = never published
  const row = selectedRow(page);

  const draftIcon = row.locator("[data-testid=tree-draft-icon]");
  await expect(draftIcon).toBeVisible();
  // #630/#530: one mechanism for every floating explanation — `data-tip`, read by the shared tooltip
  // host. The native `title` this used to assert is set by nothing any more.
  await expect(draftIcon).toHaveAttribute("data-tip", /.+/); // discoverability tooltip survives the pill removal
  await expect(row.locator("[data-testid=tree-draft-badge]")).toHaveCount(0); // the pill is gone
  await expect(row.locator("[data-testid=unpublished-dot]")).toHaveCount(0); // draft ≠ dirty

  // The title text is dimmed: same computed color as the (fg-dim) draft icon, and different
  // from a published row's title color (asserted in the published test below via the same probe).
  const nameColor = await row.locator("[data-testid=tree-page-name]").evaluate((el) => getComputedStyle(el).color);
  const iconColor = await draftIcon.locator("svg").evaluate((el) => getComputedStyle(el).color);
  expect(nameColor).toBe(iconColor);
});

test("#315 published row: FileText (no draft icon), dot only after a dirty edit, title not dimmed", async ({ page }) => {
  const pageId = await openScratch(page, "Publish Icon Probe");
  const row = selectedRow(page);

  // author something and publish → clean published state
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("published body");
  await sleep(2800); // collab persist debounce
  await publish(page, pageId);
  await page.reload(); // tree refetches published/dirty flags
  await page.waitForSelector("[data-pane=preview] .cm-content");

  await expect(row.locator("[data-testid=tree-draft-icon]")).toHaveCount(0);
  await expect(row.locator("[data-testid=unpublished-dot]")).toHaveCount(0);

  // published title is NOT dimmed: it differs from the fg-dim file icon color
  const nameColor = await row.locator("[data-testid=tree-page-name]").evaluate((el) => getComputedStyle(el).color);
  const iconColor = await row.locator("svg").first().evaluate((el) => getComputedStyle(el).color); // chevron/file glyphs are fg-dim
  expect(nameColor).not.toBe(iconColor);

  // dirty edit → the accent dot appears, and the icon does NOT flip back to the draft icon
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type(" MORE");
  await sleep(2800);
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await expect(row.locator("[data-testid=unpublished-dot]")).toBeVisible();
  await expect(row.locator("[data-testid=tree-draft-icon]")).toHaveCount(0);
});

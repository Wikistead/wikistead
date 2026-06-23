import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

const API = "http://dev.localhost:4010";

// The #2 follow-up: publishing right after typing (within the collab persist debounce)
// must NOT leave the just-typed edits behind as "unpublished changes". The publish
// route flushes the live draft before snapshotting, and storeYdoc sets the flag
// accurately, so after publish the server has NO unpublished changes and the published
// content includes everything typed. This is the anti-test for the reported bug.
test("publish flushes the live draft — no unpublished changes remain", async ({ page }) => {
  await openDemo(page);

  // Fresh page opens in edit mode with an empty draft.
  await page.getByTestId("new-page").click();
  await page.waitForURL(/\/p\/.+edit=1/);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(300); // let the editable surface settle before typing
  const pageId = new URL(page.url()).pathname.split("/p/")[1];

  // Type, then publish IMMEDIATELY — well inside the 800ms persist debounce window,
  // which is exactly the condition that used to drop the edits. (The instant-enable
  // *timing* is publish-dirty.spec's anti-test; here we only need the button enabled
  // so we can publish, then assert the flush outcome.)
  await page.click("[data-pane=preview] .cm-content");
  const text = "flush me 123";
  await page.keyboard.type(text);
  await expect(page.getByTestId("publish-page")).toBeEnabled();
  await page.getByTestId("publish-page").click();

  // Publish = done: the editor auto-returns to the rendered view, so the edit-only
  // publish control disappears (its absence == the round-trip completed). Then wait
  // past BOTH the persist debounce (800ms) and a published poll cycle (1500ms) so a
  // trailing debounced store would have re-raised the flag if the bug were present —
  // the server fetch below is the source of truth that catches it.
  await expect(page.getByTestId("edit-toggle")).toBeVisible({ timeout: 6000 });
  await sleep(2500);

  // Source of truth: the server has no unpublished changes AND the published content
  // includes everything that was typed before publishing.
  const state = await page.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/pages/${id}/published`, { headers: { Authorization: "Bearer dev-token" } });
    return (await r.json()) as { publishedMd: string | null; hasUnpublishedChanges: boolean };
  }, { api: API, id: pageId });
  expect(state.hasUnpublishedChanges).toBe(false);
  expect(state.publishedMd ?? "").toContain(text);
});

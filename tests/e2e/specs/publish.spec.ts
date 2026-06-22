import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// 2f-2 draft/publish in a REAL browser:
//  - creating a page opens it straight in the editor (draft),
//  - the live draft is NOT visible in view mode until PUBLISH,
//  - publishing makes the content appear in view,
//  - a later draft edit surfaces the "unpublished changes" indicator + sidebar dot.
const API = "http://dev.localhost:4010";

test("publish flow: create→edit, draft hidden in view until publish, then visible + unpublished badge", async ({ page }) => {
  await openDemo(page);

  // (1) create via the sidebar → opens the new draft straight in the editor (?edit=1)
  await page.click("[data-testid=new-page]");
  await page.waitForURL(/\/p\/.*edit=1/);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await expect(page.locator("[data-testid=view-toggle]")).toBeVisible(); // in EDIT mode (Done button)

  // author draft content; let it persist (collab debounce)
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("SECRETDRAFTXYZ visible only after publish");
  await sleep(2800);

  // (2) BEFORE publish: never-published → "Draft" state; view shows the published
  // snapshot (empty) — NOT the draft.
  await expect(page.locator("[data-testid=draft-badge]")).toBeVisible(); // header state
  await page.click("[data-testid=view-toggle]"); // Done → view
  await sleep(500);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("SECRETDRAFTXYZ");

  // (3) publish → the content appears in view and the Draft badge is gone
  await page.click("[data-testid=publish-page]");
  await expect
    .poll(async () => page.locator("[data-pane=preview] .cm-content").innerText(), { timeout: 8000 })
    .toContain("SECRETDRAFTXYZ");
  await expect(page.locator("[data-testid=draft-badge]")).toHaveCount(0);

  // (4) edit again → the "unpublished changes" indicator appears
  await page.click("[data-testid=edit-toggle]");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type(" MORE");
  await sleep(2800);
  await expect(page.locator("[data-testid=unpublished-badge]")).toBeVisible({ timeout: 8000 });

  // (5) the sidebar shows the unpublished dot on this page (after the tree refetches)
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await expect(page.locator("[data-testid=tree-page][data-selected] [data-testid=unpublished-dot]")).toBeVisible();
});

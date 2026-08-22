import { test, expect, type Page } from "@playwright/test";
import { openDemo, openScratch, enterEdit, sleep, API, DEV_USER_SHOWN } from "../helpers";

// P4 UX in a REAL browser: page comments + resolve/tabs, inline comment anchored to
// a selection (blue underline) that FOLLOWS a live edit, and @mention autocomplete
// scoped to page-viewers. Uses a unique page (not the shared demo doc).
// #212: the comments toggle moved from the always-visible bar INTO the ⋯ overflow menu.
// Open the overflow, then click the comments item (which toggles the RightPanel, exclusive).
async function openComments(page: Page) {
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=comments-toggle]");
  // Wait for the Radix dropdown to fully close before any following keyboard step — otherwise its
  // dismissable layer can swallow the next Escape (which the panel's own Esc-to-close relies on).
  await page.locator("[data-testid=page-overflow]").waitFor({ state: "detached" }).catch(() => {});
}


test("comments: page comment + @mention; resolve/tabs and inline affordance removed (#214)", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "P4 comments page" }),
    });
    return (await r.json()).id as string;
  }, API);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("The quick brown fox jumps");
  await sleep(400);

  // Comments panel is toggled now — open it.
  await openComments(page);
  const panel = page.locator("[data-testid=comments-panel]");
  await expect(panel).toBeVisible();

  // (1) page-level comment via the bottom composer.
  const pageInput = panel.locator("[data-testid=comment-input]").last();
  await pageInput.fill("a page-level comment");
  await panel.locator("[data-testid=comment-submit]").last().click();
  await expect(panel.locator("[data-testid=comment-thread]")).toContainText("a page-level comment");

  // (2) #214 part 1 (comment 738): NO selection/inline comment affordance — asserted by the RENDERED
  // TEXT, not just a testid (the prior testid-only check passed while the button was actually present).
  await expect(page.getByText("選択範囲にコメント")).toHaveCount(0);
  await expect(page.getByText("Comment on selection")).toHaveCount(0);
  await expect(panel.locator("[data-testid=thread-toggle]")).toHaveCount(0);
  await expect(panel.locator("[data-testid=tab-resolved]")).toHaveCount(0);

  // (3) part 3: each comment shows a timestamp.
  await expect(panel.locator("[data-testid=comment-time]").first()).toBeVisible();

  // (4) part 2: a comment has a REPLY button (not an always-expanded reply box); clicking it retargets
  // the single bottom composer to that thread (reply banner appears).
  await expect(panel.locator("[data-testid=comment-input]")).toHaveCount(1); // ONE composer, not one-per-comment
  await panel.locator("[data-testid=comment-reply]").first().click();
  await expect(panel.locator("[data-testid=reply-banner]")).toBeVisible();
  await panel.locator("[data-testid=reply-cancel]").click();
  await expect(panel.locator("[data-testid=reply-banner]")).toHaveCount(0);

  // (5) part 4: the composer is pinned FLUSH to the panel's bottom — no gap / see-through below it.
  const gap = await page.evaluate(() => {
    const p = document.querySelector("[data-testid=comments-panel]")!.getBoundingClientRect();
    const c = document.querySelector("[data-testid=comment-composer]")!.getBoundingClientRect();
    return Math.round(p.bottom - c.bottom);
  });
  expect(gap, "the composer's bottom must meet the panel's bottom (no gap/see-through)").toBeLessThanOrEqual(1);

  // (6) @mention autocomplete from the page-view-scoped directory. dev-user is the only page-viewer.
  await pageInput.fill("@dev");
  await expect(panel.locator("[data-testid=mention-suggest]")).toBeVisible({ timeout: 6000 });
  await expect(panel.locator("[data-testid=mention-option]").first()).toContainText(DEV_USER_SHOWN); // #902
});

// Light-1: the panel closes in place via × or Esc, but NOT on an outside click (it is
// used while reading the body). The toggle still works. Esc is deferred to the editor
// when the editor is focused (it owns Esc for vim/palette).
test("comments panel: × and Esc close it; outside-click and editor-Esc do not", async ({ page }) => {
  await openScratch(page, "comments-close");
  await enterEdit(page);
  await openComments(page);
  const panel = page.getByTestId("comments-panel");
  await expect(panel).toBeVisible();

  // outside-click in the editor does NOT close the panel
  await page.click("[data-pane=preview] .cm-content");
  await sleep(100);
  await expect(panel).toBeVisible();

  // Esc while the EDITOR is focused does NOT close it (the editor owns Esc)
  await page.keyboard.press("Escape");
  await sleep(100);
  await expect(panel).toBeVisible();

  // × closes it
  await page.getByTestId("comments-close").click();
  await expect(panel).toHaveCount(0);

  // re-open; Esc with focus in the panel closes it
  await openComments(page);
  await expect(panel).toBeVisible();
  await page.getByTestId("comments-close").focus();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

// #214 comment 751: (1) the reply banner previews the TARGET comment's content; (2) deleting the last
// comment of a thread leaves NO empty thread frame; (3) no resolve wording ("resolved"/"unresolved" in any locale)
// appears anywhere — the empty state is resolve-agnostic. Verified by real rendered DOM (not just testids).
test("#214 comment 751: reply preview, no empty thread on delete, no resolve wording", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, { method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ title: "P4 comments 751" }) });
    return (await r.json()).id as string;
  }, API);
  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await openComments(page);
  const panel = page.locator("[data-testid=comments-panel]");
  await expect(panel).toBeVisible();

  // (3) empty state carries no resolve wording (real rendered text)
  const list = panel.locator("[data-testid=comment-list]");
  for (const w of ["未解決", "解決", "resolved", "Resolved", "unresolved"]) {
    await expect(page.getByText(w, { exact: false })).toHaveCount(0);
  }

  // post a page comment
  await panel.locator("[data-testid=comment-input]").last().fill("parent comment body");
  await panel.locator("[data-testid=comment-submit]").last().click();
  await expect(panel.locator("[data-testid=comment-thread]")).toHaveCount(1);

  // (1) reply → banner previews the target comment's content
  await panel.locator("[data-testid=comment-reply]").first().click();
  await expect(panel.locator("[data-testid=reply-preview]")).toContainText("parent comment body");
  await panel.locator("[data-testid=reply-cancel]").click();

  // (2) delete the only comment → the empty thread frame does NOT remain
  await panel.locator("[data-testid=comment-delete]").first().click();
  await page.getByTestId("comment-delete-confirm").click(); // #504: delete confirms first
  await expect(panel.locator("[data-testid=comment-thread]")).toHaveCount(0);
  await expect(list).not.toContainText("未解決");
});

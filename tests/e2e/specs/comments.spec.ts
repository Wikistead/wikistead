import { test, expect, type Page } from "@playwright/test";
import { openDemo, openScratch, enterEdit, sleep } from "../helpers";

// P4 UX in a REAL browser: page comments + resolve/tabs, inline comment anchored to
// a selection (blue underline) that FOLLOWS a live edit, and @mention autocomplete
// scoped to page-viewers. Uses a unique page (not the shared demo doc).
const API = "http://dev.localhost:4010";

// #212: the comments toggle moved from the always-visible bar INTO the ⋯ overflow menu.
// Open the overflow, then click the comments item (which toggles the RightPanel, exclusive).
async function openComments(page: Page) {
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=comments-toggle]");
  // Wait for the Radix dropdown to fully close before any following keyboard step — otherwise its
  // dismissable layer can swallow the next Escape (which the panel's own Esc-to-close relies on).
  await page.locator("[data-testid=page-overflow]").waitFor({ state: "detached" }).catch(() => {});
}


test("comments: page comment + resolve/tabs, inline highlight that follows edits, @mention", async ({ page }) => {
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

  // (1) page-level comment (the page composer is the last comment-input in the panel)
  const pageInput = panel.locator("[data-testid=comment-input]").last();
  await pageInput.fill("a page-level comment");
  await panel.locator("[data-testid=comment-submit]").last().click();
  await expect(panel.locator("[data-testid=comment-thread]")).toContainText("a page-level comment");

  // (2) #214 part 2: resolve/open-resolved tabs were removed — the thread stays in the single list.
  await expect(panel.locator("[data-testid=thread-toggle]")).toHaveCount(0);
  await expect(panel.locator("[data-testid=tab-resolved]")).toHaveCount(0);

  // (3) inline comment anchored to the selected line → blue-underline highlight
  page.once("dialog", (d) => d.accept("comment on the line"));
  await page.locator("[data-pane=preview] .cm-line").first().click({ clickCount: 3 }); // select the line
  await page.locator("[data-testid=add-inline]").click();
  await expect(page.locator("[data-pane=preview] .cm-comment-anchor")).toBeVisible({ timeout: 8000 });

  // (4) the highlight FOLLOWS a live edit (real CodeMirror, complementing the unit test)
  await page.locator("[data-pane=preview] .cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("XX ");
  await sleep(300);
  await expect(page.locator("[data-pane=preview] .cm-comment-anchor")).toContainText("quick");

  // (5) @mention autocomplete from the page-view-scoped directory. dev-user is the
  // only page-viewer member; its display name is "dev-user" (the IdP claim name set
  // at login). Typing "@dev" surfaces it from the view-scoped directory.
  await pageInput.fill("@dev");
  await expect(panel.locator("[data-testid=mention-suggest]")).toBeVisible({ timeout: 6000 });
  await expect(panel.locator("[data-testid=mention-option]").first()).toContainText("dev-user");
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

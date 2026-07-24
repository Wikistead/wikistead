import { test, expect } from "@playwright/test";
import { openDemo, sleep, publishAndWait, API } from "../helpers";
// #326 / ADR-142: the Recent Changes activity view — the cross-space feed (the #320 backend served it but no
// web surface consumed it) + the moderation patrol toggle + the "unpatrolled only" filter. Member-only + the
// server view-filters every event. Real Chromium: publish a page (→ a page.published feed event), then drive
// the view.
test("#326: Recent Changes lists published events, patrol marks them, and the unpatrolled filter hides them", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  const title = `RC-${Date.now().toString(36)}`;
  const id = await page.evaluate(async ({ api, title }) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return ((await r.json()) as { id: string }).id;
  }, { api: API, title });
  // author + publish so a page.published feed event is fanned out.
  await page.goto(`/p/${id}?edit=1`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("recent changes body 326");
  await publishAndWait(page, id, "recent changes body 326");

  await page.goto("/changes");
  await expect(page.getByTestId("recent-changes-page")).toBeVisible();
  // the just-published page shows in the feed (server view-filtered; the member can see their own page).
  const list = page.getByTestId("recent-changes-list");
  await expect(list).toContainText(title, { timeout: 8000 });

  // the matching item + its patrol toggle. Patrol it (mark reviewed) → the button reflects the pressed state.
  const item = page.getByTestId("recent-changes-item").filter({ hasText: title }).first();
  await expect(item).toBeVisible();
  const patrol = item.getByRole("button", { name: /review/i });
  await expect(patrol).toHaveAttribute("aria-pressed", "false");
  await patrol.click();
  await expect(item).toHaveAttribute("data-patrolled", "true", { timeout: 8000 });

  // "unpatrolled only" filter → the now-patrolled event is filtered out (LEFT JOIN patrolled_events IS NULL).
  await page.getByTestId("recent-changes-unpatrolled").click();
  await sleep(600);
  await expect(page.getByTestId("recent-changes-item").filter({ hasText: title })).toHaveCount(0);
});

import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";

// #326 / ADR-142 Addendum 2: the space Moderation tab renders the patrol queue and its reviewed
// toggle. The queue's CONTENT rules (what counts as supply, and that a flag for a page you cannot
// view never appears) are anti-tested server-side; this pins that the surface exists, is reachable
// from space settings, and shows the right empty state rather than a blank panel.
test("#326: the space settings Moderation tab shows the patrol queue", async ({ page }) => {
  await page.goto("/spaces/demo_space/settings/general");
  const tab = page.getByTestId("settings-tab-moderation");
  await expect(tab, "space settings opened").toBeVisible({ timeout: 10_000 });
  await expect(tab, "the tab is offered to a manager").toBeVisible();
  await tab.click();
  await expect(page.getByTestId("space-moderation")).toBeVisible();
  await sleep(500);
  // "Needs review" is on by default — the queue's job is what still needs looking at.
  await expect(page.getByTestId("moderation-unpatrolled")).toHaveAttribute("aria-pressed", "true");
  // Either a list or the explicit empty state; never a blank panel.
  const list = page.getByTestId("moderation-list");
  const empty = page.getByTestId("moderation-empty");
  expect((await list.count()) + (await empty.count()), "the panel says something").toBeGreaterThan(0);
  // and a denial must never masquerade as an empty queue
  await expect(page.getByTestId("moderation-denied")).toHaveCount(0);
});

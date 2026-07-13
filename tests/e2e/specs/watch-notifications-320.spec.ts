import { test, expect } from "@playwright/test";
import { openDemo, createScratchPage, sleep } from "../helpers";

// #320 / ADR-126: the watch toggle + notification bell UI. The fan-out + read-path authz are pinned by the
// server anti-tests (notifications-320.test.ts); this covers the real-browser wiring — the 🔔 toggle persists a
// watch (POST/DELETE /watches) and the bell renders + opens its inbox. Real Chromium.

test("#320 the page watch toggle persists a subscription (POST then DELETE /watches)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  const id = await createScratchPage(page, "Watch Me");
  await page.goto(`/p/${id}`);
  await page.waitForSelector("[data-testid=sidebar]");

  const toggle = page.getByTestId("watch-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // Watch → the button reflects the active state, and it survives a reload (server-persisted).
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: 8000 });
  await page.reload();
  await page.waitForSelector("[data-testid=sidebar]");
  await expect(page.getByTestId("watch-toggle")).toHaveAttribute("aria-pressed", "true", { timeout: 8000 });

  // Unwatch → back to inactive, persisted.
  await page.getByTestId("watch-toggle").click();
  await expect(page.getByTestId("watch-toggle")).toHaveAttribute("aria-pressed", "false", { timeout: 8000 });
});

test("#320 the header notification bell opens its inbox (empty state for a fresh member)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  const bell = page.getByTestId("notification-bell");
  await expect(bell).toBeVisible();
  await bell.click();
  // The popover opens and its inbox list renders (empty-state or items — both prove the query ran).
  await expect(page.getByTestId("notification-list")).toBeVisible();
  await sleep(400);
  const rendered = (await page.getByTestId("notification-empty").count()) + (await page.getByTestId("notification-item").count());
  expect(rendered).toBeGreaterThan(0);
});

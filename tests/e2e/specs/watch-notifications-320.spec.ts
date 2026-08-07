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

  // #368: the watch control is a ⋯-overflow-menu ITEM now (an aria-checked toggle with the Eye glyph), not a
  // standalone round button — open the ⋯ menu to reach it. Selecting it closes the menu, so re-open to verify.
  const openMenu = () => page.getByTestId("page-overflow-trigger").click();
  const watchItem = () => page.getByTestId("watch-toggle");
  const reopenAfterReload = async () => { await page.reload(); await page.waitForSelector("[data-testid=sidebar]"); await openMenu(); };
  // Selecting the item closes the menu AND fires the mutation; wait for the /watches round-trip to settle
  // before reloading (reloading mid-request aborts it). We toggle inside an already-open menu, then reload to
  // re-open a fresh menu — never Escape-then-reopen (Radix swallows the immediate re-open click after Escape).
  const clickWatch = (method: "POST" | "DELETE") => Promise.all([
    page.waitForResponse((r) => r.url().includes("/watches") && r.request().method() === method && r.ok(), { timeout: 8000 }),
    watchItem().click(),
  ]);

  await openMenu();
  await expect(watchItem()).toBeVisible();
  await expect(watchItem()).toHaveAttribute("aria-checked", "false");

  // Watch (POST) → survives a reload (server-persisted).
  await clickWatch("POST");
  await reopenAfterReload();
  await expect(watchItem()).toHaveAttribute("aria-checked", "true", { timeout: 8000 });

  // Unwatch (DELETE) → back to inactive, persisted.
  await clickWatch("DELETE");
  await reopenAfterReload();
  await expect(watchItem()).toHaveAttribute("aria-checked", "false", { timeout: 8000 });
});

test("#320 the header notification bell opens its inbox (empty state for a fresh member)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  const bell = page.getByTestId("notification-bell");
  await expect(bell).toBeVisible();
  await bell.click();
  // The popover opens and its inbox list renders (empty-state or items — both prove the query ran).
  await expect(page.getByTestId("notification-list")).toBeVisible();
  // WAIT for the outcome instead of sleeping and then counting. The list renders a loading branch first
  // (`notifications.loading`), and a fixed 400ms is a bet on how long the query takes — lose it and the
  // count is zero because nothing has arrived yet, which reads as "the inbox rendered neither state".
  await expect(
    page.getByTestId("notification-empty").or(page.getByTestId("notification-item")).first(),
    "the inbox settles on one state or the other",
  ).toBeVisible({ timeout: 10_000 });
});

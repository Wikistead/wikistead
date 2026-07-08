import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #253 / ADR-113: the public-toggle UI wiring end-to-end. The admin tab flips the tenant PARENT SWITCH; only
// then does the per-page Permissions dialog offer the PUBLIC toggle; toggling it public lets an anonymous
// visitor render the page. Real Chromium.
test("#253 UI: admin enables the surface, a manager makes a page public via the dialog, anon views it", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();

  // 1. Create + publish a page.
  const id = await openScratch(authed, "pubui");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("# Public via UI\n\nbody text\n");
  await sleep(300);
  await authed.getByTestId("publish-page").click();
  await sleep(800);

  // 2. Admin: enable the public surface via the admin tab (the tenant parent switch).
  await authed.goto("/admin/public");
  await expect(authed.getByTestId("admin-public")).toBeVisible();
  const surface = authed.getByTestId("public-surface-toggle");
  if (!(await surface.isChecked())) await surface.click();
  await expect(surface).toBeChecked();

  // 3. Open the page → Permissions dialog → the PUBLIC toggle is offered (surface ON) → turn it on.
  await authed.goto(`/p/${id}`);
  await authed.waitForSelector("[data-pane=preview] .cm-content");
  await authed.click("[data-testid=page-overflow-trigger]");
  await authed.click("[data-testid=permissions-open]");
  await expect(authed.getByTestId("permissions-dialog")).toBeVisible();
  const pub = authed.getByTestId("public-toggle");
  await expect(pub).toBeVisible();
  await pub.click();
  await sleep(500);

  // 4. A fresh anonymous context renders the now-public page.
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByTestId("public-title")).toBeVisible();
  await expect(anon.getByTestId("public-body")).toContainText("body text");
});

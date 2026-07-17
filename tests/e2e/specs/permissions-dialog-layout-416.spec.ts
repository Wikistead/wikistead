import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// #416 the Permissions dialog must NEVER outgrow the viewport — bounded max-h flex column,
// header/footer fixed, ONE scrolling body between them. Pin with a dozen grants (the reported
// real-device overflow) on a real Chromium viewport.
const API = "http://dev.localhost:4010";

test("#416 the dialog stays inside the viewport with 12 grants; Close reachable; body scrolls", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "perms layout page" }),
    });
    const id = (await r.json()).id as string;
    // 12 grants straight through the API — the dialog must absorb them without growing past the viewport.
    for (let i = 0; i < 12; i++) {
      await fetch(`${api}/pages/${id}/access`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
        body: JSON.stringify({ grantee: `user:layout-grantee-${i}`, relation: "view" }),
      });
    }
    return id;
  }, API);

  await page.setViewportSize({ width: 1000, height: 640 }); // short viewport = the overflow repro
  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  const dialog = page.locator("[data-testid=permissions-dialog]");
  await expect(dialog).toBeVisible();
  await expect(page.locator("[data-testid=grant-item]").nth(10)).toHaveCount(1); // grants loaded

  const box = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y, "dialog top inside the viewport").toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, "dialog bottom inside the viewport").toBeLessThanOrEqual(viewport.height + 1);
  expect(box.x + box.width, "no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);

  // The single body scroller actually scrolls (content taller than the bounded body)…
  const body = page.locator("[data-testid=permissions-body]");
  const scroll = await body.evaluate((el) => ({ scrollH: el.scrollHeight, clientH: el.clientHeight }));
  expect(scroll.scrollH, "body content overflows into the inner scroller").toBeGreaterThan(scroll.clientH);
  // …and the footer Close button is visible and clickable WITHOUT scrolling the page.
  const close = dialog.getByRole("button", { name: /close|閉じる/i }).last();
  await expect(close).toBeVisible();
  await close.click();
  await expect(dialog).toBeHidden();
});

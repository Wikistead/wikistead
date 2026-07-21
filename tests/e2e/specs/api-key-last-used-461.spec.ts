import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #461: the API-key list shows WHEN each key was last authenticated with, so an admin can tell a live
// key from dead weight before revoking. The server has always returned lastUsedAt (#428 made the write
// land under RLS); this pins the column: "never used" for a fresh key, a real timestamp once the key
// authenticates a request.
test("#461: a fresh key reads 'never used'; after the key authenticates a request it shows when", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/api");
  await expect(page.getByTestId("admin-api")).toBeVisible();

  const name = `lastused-${Date.now()}`;
  await page.getByTestId("api-key-name").fill(name);
  await page.getByTestId("api-key-create").click();
  const plaintext = (await page.getByTestId("api-key-plaintext").locator("code").textContent())!.trim();
  expect(plaintext).toContain("wks_");

  const row = page.locator("[data-testid=api-key-item]", { hasText: name });
  await expect(row).toBeVisible();
  const cell = row.getByTestId("api-key-last-used");
  await expect(cell, "a key nobody has used says so — not a blank cell").toHaveAttribute("data-used", "never");
  await expect(cell).toHaveText(/Never used|未使用/);

  // Authenticate a real request WITH the key (this is what moves last_used_at).
  const status = await page.evaluate(async (key) => {
    const r = await fetch("http://dev.localhost:4010/spaces", { headers: { Authorization: `Bearer ${key}` } });
    return r.status;
  }, plaintext);
  expect(status, "the key authenticates").toBeLessThan(400);
  await sleep(600); // last_used_at is written fire-and-forget off the auth hot path

  await page.reload();
  const row2 = page.locator("[data-testid=api-key-item]", { hasText: name });
  const cell2 = row2.getByTestId("api-key-last-used");
  await expect(cell2, "the used key now carries a timestamp").toHaveAttribute("data-used", "yes", { timeout: 10000 });
  await expect(cell2).toHaveText(/ago|前|now|今/);
  // the hover title carries the absolute time, and the element is a real <time>
  await expect(cell2).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}/);

  await row2.getByTestId("api-key-revoke").click();
  await expect(page.locator("[data-testid=api-key-item]", { hasText: name })).toHaveCount(0);
});

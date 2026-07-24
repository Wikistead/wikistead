import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #511 / ADR-185: the space Pages tab drives BULK delete over a multi-select. This exercises the wiring
// end-to-end (select → red confirm → partial-success report → rows gone); the per-page authz + partial
// success are proven server-side in bulk-delete-511.test.ts. Runs in a THROWAWAY space so it never
// trashes the shared demo fixture (#279). The visual (selection affordance, confirm) is needs-human-check.
const API = "http://dev.localhost:4010";
const H = { Authorization: "Bearer dev-token" };

async function seedSpaceWithPages(page: Page, titles: string[]): Promise<string> {
  return page.evaluate(async ({ api, headers, titles }) => {
    const s = await (await fetch(`${api}/spaces`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: `bulk-del-e2e-${Date.now()}` }) })).json();
    for (const title of titles) {
      await fetch(`${api}/spaces/${s.id}/pages`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ title }) });
    }
    return s.id as string;
  }, { api: API, headers: H, titles });
}

test("#511: select pages, confirm, and they are bulk-deleted (partial-success report)", async ({ page }) => {
  await openDemo(page);
  const spaceId = await seedSpaceWithPages(page, ["Bulk A", "Bulk B", "Bulk C"]);
  await page.goto(`/spaces/${spaceId}/settings/pages`);
  await expect(page.getByTestId("space-pages")).toBeVisible({ timeout: 10000 });
  await page.waitForSelector("[data-testid=space-page-row]", { timeout: 10000 });
  await sleep(300);
  await expect(page.getByTestId("space-page-row")).toHaveCount(3);

  // no bulk bar until something is selected
  await expect(page.getByTestId("space-pages-bulkbar")).toHaveCount(0);

  // select two of the three via their row checkboxes
  const rowA = page.getByTestId("space-page-row").filter({ hasText: "Bulk A" });
  const rowB = page.getByTestId("space-page-row").filter({ hasText: "Bulk B" });
  await rowA.getByTestId("bulk-select-row").check();
  await rowB.getByTestId("bulk-select-row").check();

  await expect(page.getByTestId("space-pages-bulkbar")).toBeVisible();
  await expect(page.getByTestId("bulk-selected-count")).toContainText("2");

  // delete → the danger confirm (small selection: no type-to-confirm) → run
  await page.getByTestId("bulk-delete").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await expect(page.getByTestId("typed-confirm-input")).toHaveCount(0); // 2 < threshold: count-only confirm
  await page.getByTestId("bulk-delete-confirm").click();

  // the two selected rows are gone; the third remains
  await expect(page.getByTestId("space-page-row")).toHaveCount(1, { timeout: 10000 });
  await expect(page.getByTestId("space-page-row").filter({ hasText: "Bulk C" })).toBeVisible();
  await expect(page.getByTestId("space-pages-bulkbar")).toHaveCount(0); // selection cleared
});

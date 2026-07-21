import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #463: the space settings "Pages" tab is table-fixed, so the title column is whatever the fixed
// columns leave over — and below ~520px they left nothing, collapsing the title to 0px and making
// rows unidentifiable. The title now keeps a minimum width (truncating, as #439 intended) and the
// table scrolls inside its own box rather than the page.

async function openPagesTab(page: import("@playwright/test").Page) {
  await openDemo(page);
  const spaceId = await page.evaluate(async () => {
    const r = await fetch("http://dev.localhost:4010/spaces", { headers: { Authorization: "Bearer dev-token" } });
    const spaces = (await r.json()) as { id: string; name: string }[];
    return spaces[0]!.id;
  });
  await page.goto(`/spaces/${spaceId}/settings/pages`);
  await expect(page.getByTestId("space-pages")).toBeVisible({ timeout: 10000 });
  await page.waitForSelector("[data-testid=space-page-row]", { timeout: 10000 });
  await sleep(300);
}

test("#463: at 520px the title column stays readable and the table scrolls in its own box", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await openPagesTab(page);

  const titleCell = page.locator("[data-testid=space-page-row] td").first();
  const w = await titleCell.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(w, "the title column has real width (was 0)").toBeGreaterThan(120);

  // it truncates rather than wrapping into a tall block
  const inner = titleCell.locator("div").first();
  expect(await inner.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
  const h = await titleCell.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(h, "one line, not a wrapped block").toBeLessThan(60);

  // #439 non-regression: the status badge stays on one line
  const badgeH = await page.locator("[data-testid=space-page-row] td").nth(1).evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(badgeH).toBeLessThan(60);

  // any overflow is the table's own scroller — the page itself never scrolls sideways
  const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(docOverflow, "the page does not scroll horizontally").toBe(false);
  const scroller = page.getByTestId("space-pages-scroller");
  expect(await scroller.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
});

test("#463: a wide viewport is unchanged (title takes the remaining width)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPagesTab(page);
  const w = await page.locator("[data-testid=space-page-row] td").first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(w, "wide layout still gives the title the leftover width").toBeGreaterThan(300);
});

import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #586 (review rejection): built-in and custom role rows differ in size, which looks wrong. Built-in rows
// measured 17px and custom rows 32px — only the custom ones carry IconButtons, and the row had no box
// of its own, so nearly-double-height rows alternated down one list.
//
// The rows are picked up MECHANICALLY (every row header inside each list), not by naming the kinds this
// test knows about: a new kind of row is covered by existing. The assertion is that the set of heights
// has one member — a relation among the rows themselves, so it cannot pass on a wrong-but-uniform
// constant either.
async function rowHeights(page: import("@playwright/test").Page, listTestId: string): Promise<number[]> {
  return page.evaluate((id) => {
    const list = document.querySelector(`[data-testid=${id}]`)!;
    // a row is a direct child of the list; its HEADER is the first element child (name + badges +
    // whatever affordances that kind of row has)
    return Array.from(list.children)
      .map((row) => row.firstElementChild)
      .filter((el): el is Element => el != null)
      .map((el) => Math.round(el.getBoundingClientRect().height));
  }, listTestId);
}

test("#586: every role row is the same height, built-in or custom", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/roles");
  await expect(page.getByTestId("roles-list-resource")).toBeVisible({ timeout: 10_000 });
  await sleep(500);

  for (const list of ["roles-list-tenant", "roles-list-resource"]) {
    const heights = await rowHeights(page, list);
    // enough rows to compare at all (the tenant section is member + admin plus whatever tenant-scope
    // custom roles exist; the mix of KINDS is asserted for the page below, where it is guaranteed)
    expect(heights.length, `${list}: rows were found`).toBeGreaterThanOrEqual(2);
    expect(
      [...new Set(heights)],
      `${list}: rows must share one height — measured ${heights.join(", ")}`,
    ).toHaveLength(1);
  }

  // and the list genuinely mixes the two kinds (otherwise uniformity is trivially true)
  const builtIns = await page.locator("[data-testid^='builtin-role-']").count();
  const customs = await page.getByTestId("custom-role-row").count();
  expect(builtIns, "built-in rows are present").toBeGreaterThan(2);
  expect(customs, "custom rows are present — the mix is what the reject was about").toBeGreaterThan(0);
});

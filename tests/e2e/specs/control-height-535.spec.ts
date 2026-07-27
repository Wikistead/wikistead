import { test, expect } from "@playwright/test";

// #535: a form row holding a Select, an Input and a Button was ragged — the Button sized itself from its
// padding (~28px) while the other two declare heights (34 / 38). Fixed in the design system so every such
// row lands at once; this measures the rows in a real browser, because px is the whole complaint.
const ROWS = [
  { url: "/admin/roles", row: "[data-testid=mapping-form]", name: "tenant group mapping" },
  { url: "/spaces/demo_space/settings/members", row: "[data-testid=space-role-assign]", name: "space role assignment" },
];

for (const { url, row, name } of ROWS) {
  test(`#535: the ${name} row's controls share a height`, async ({ page }) => {
    await page.goto(url);
    await page.waitForSelector(row, { timeout: 15_000 });

    const heights = await page.evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root) return null;
      const pick = (q: string) => [...root.querySelectorAll<HTMLElement>(q)]
        .filter((e) => e.offsetParent !== null)
        .map((e) => Math.round(e.getBoundingClientRect().height));
      return {
        buttons: pick("button:not([data-slot=select-trigger])"),
        selects: pick("[data-slot=select-trigger]"),
        inputs: pick("input"),
      };
    }, row);

    expect(heights, "the row rendered").not.toBeNull();
    const all = [...heights!.buttons, ...heights!.selects, ...heights!.inputs].filter((h) => h > 0);
    expect(all.length, "the row really holds controls").toBeGreaterThanOrEqual(2);
    // one height across the row (±1px for sub-pixel borders)
    expect(Math.max(...all) - Math.min(...all), `heights: ${JSON.stringify(heights)}`).toBeLessThanOrEqual(1);
  });
}

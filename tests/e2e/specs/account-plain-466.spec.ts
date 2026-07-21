import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #466: the personal account settings screen used to wrap every group in a CARD (surface-2 +
// hairline border + radius) while every OTHER settings screen groups with a heading + spacing on
// the plain panel. Same product, two looks. This pins the parity in a real browser: the account
// sections carry no card chrome, and their computed background matches a reference tab's.
test("#466: account settings sections carry no card chrome (parity with the other settings tabs)", async ({ page }) => {
  await openDemo(page);

  // reference: the tenant-branding admin tab (plain sections, no cards)
  await page.goto("/admin/branding");
  await expect(page.getByTestId("tenant-branding")).toBeVisible({ timeout: 10_000 });
  const refBg = await page.getByTestId("tenant-branding").evaluate((el) => getComputedStyle(el).backgroundColor);

  await page.goto("/settings/account/editor");
  const section = page.getByTestId("account-atom-policy");
  await expect(section).toBeVisible({ timeout: 10_000 });
  await sleep(200);

  const style = await section.evaluate((el) => {
    const c = getComputedStyle(el);
    return { border: c.borderTopWidth, radius: c.borderTopLeftRadius, bg: c.backgroundColor, padding: c.paddingTop };
  });
  expect(style.border, "no card border").toBe("0px");
  expect(style.radius, "no card radius").toBe("0px");
  expect(style.padding, "no card padding").toBe("0px");
  // transparent (or exactly the reference surface) — never the raised panel-2 card fill
  expect(["rgba(0, 0, 0, 0)", refBg], `section background (${style.bg})`).toContain(style.bg);
});

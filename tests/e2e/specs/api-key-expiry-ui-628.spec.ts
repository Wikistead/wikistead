import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #628 (review rejection): whatever ceiling a tenant sets, the form can still issue a key.
//
// Measured before this: a 3-day ceiling produced ZERO options and a blank control, while the API
// accepted 2 days without complaint — the product refusing through its own form what its own server
// would have granted, and the tighter the policy the fewer keys anyone could make.
//
// The policy GET is stubbed so the ceilings can be swept; creation is not touched (the #537 pattern).
// Ceilings are chosen to straddle the round numbers the ladder prefers, so an implementation that
// filters a fixed list instead of deriving from the ceiling fails on the ones below its smallest rung.
const CEILINGS = [null, 1, 3, 7, 89, 90, 400] as const;

async function stubPolicy(page: import("@playwright/test").Page, maxAgeDays: number | null) {
  for (const route of ["**/api/api-keys/policy", "**/api/admin/api-policy"]) {
    await page.route(route, (r) =>
      r.request().method() === "GET"
        ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ canIssue: true, maxScope: "write", maxAgeDays }) })
        : r.fallback());
  }
}

for (const surface of [
  { name: "admin", path: "/admin/api" },
  { name: "account", path: "/settings/account/api-keys" },
] as const) {
  for (const cap of CEILINGS) {
    test(`#628: ${surface.name} surface can still issue a key at a ceiling of ${cap}`, async ({ page }) => {
      await stubPolicy(page, cap);
      await openDemo(page);
      await page.goto(surface.path);
      await expect(page.getByTestId("api-key-expiry")).toBeVisible({ timeout: 10_000 });
      await sleep(400);

      const trigger = page.getByTestId("api-key-expiry");
      // the control shows SOMETHING — a Select whose value matches no option renders as a bare chevron
      const label = (await trigger.innerText()).trim();
      expect(label, `ceiling ${cap}: the control is blank, so its value matches no option`).not.toBe("");

      await trigger.click();
      await sleep(300);
      const options = await page.locator("[role=option]").allInnerTexts();
      expect(options.length, `ceiling ${cap}: the form offered nothing`).toBeGreaterThan(0);
      // …and what it starts on is one of them
      expect(options.map((o) => o.trim()), `ceiling ${cap}: the selected label is not among the options`).toContain(label);
      await page.keyboard.press("Escape");
    });
  }
}

// #635: the members screen says "assign a role" (was "give a role"). Rendered, not just present in the
// locale file — a key can be right while nothing reads it. Asserted in English because that is the
// locale the harness runs; the Japanese side is covered by the locale sweep in
// `i18n/role-assignment-wording-635.test.ts`, which is where the ruling's wording lives.
test("#635: the members screen uses the assign verb", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/members");
  await sleep(1000);
  const body = await page.evaluate(() => document.body.innerText);
  expect(body, "the retired wording is gone from the screen").not.toContain("Give a role");
  expect(body, "and the ruling's wording is what shows").toContain("Assign a role");
});

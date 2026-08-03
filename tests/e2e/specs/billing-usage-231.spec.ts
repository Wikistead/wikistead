import { test, expect } from "@playwright/test";
import { API, openDemo } from "../helpers";

// #231: the metered counters, on screen. The unit tests pin the shape; what a browser adds is that
// the number an admin reads is the number the server counted — and that an UNLIMITED allowance does
// not render as a limit of zero, which is the mistake that would look like a working screen.
const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };

test("#231: the billing screen shows what has been metered this period", async ({ page }) => {
  // What the server says, so the screen can be compared against it rather than against a guess.
  const res = await fetch(`${API}/billing/usage`, { headers: H });
  const body = await res.text();
  expect(res.status, body).toBe(200);
  const usage = JSON.parse(body) as { resources: { resource: string; used: number; allowance: number | null }[] };
  expect(usage.resources.length, "the endpoint reports at least one metered resource").toBeGreaterThan(0);
  const first = usage.resources[0]!;

  await openDemo(page);
  await page.goto("/admin/billing");
  await expect(page.getByTestId("admin-billing")).toBeVisible({ timeout: 10_000 });
  const row = page.getByTestId(`billing-usage-${first.resource}`);
  await expect(row, "the resource the server reported has a row").toBeVisible();

  const text = (await row.textContent()) ?? "";
  expect(text, "the number on screen is the number the server counted").toContain(new Intl.NumberFormat().format(first.used));
  if (first.allowance === null) {
    // The failure this catches: formatting `null` as a number prints 0, so an unlimited plan would
    // read as "used N of 0" — a limit nobody has, shown as already exceeded.
    expect(text, "an unlimited allowance never renders as a number").not.toMatch(/\bof 0\b|\/\s*0\b/);
  } else {
    expect(text).toContain(new Intl.NumberFormat().format(first.allowance));
  }
});

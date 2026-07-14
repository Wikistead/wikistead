import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #101 / ADR-034: the auto-enrolment config section in the admin Auth tab. Real-browser verified — the
// section renders (no rules-of-hooks crash), the policy select toggles the domain/groups inputs, and
// adding an enrol domain shows its DNS-TXT challenge (pending). Guards the "refetch resets the selector"
// bug (a domain add refetches; the picked policy must persist so the domain manager stays).
test("#101: enrolment section — policy toggles + add domain shows the DNS challenge", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/auth");
  await expect(page.getByTestId("admin-enrollment")).toBeVisible();

  // #389 / ADR-146: the policy picker is a card radiogroup now — options are clicked directly
  // (no Select trigger to open first).
  await page.getByTestId("enroll-policy-groups").click();
  await expect(page.getByTestId("enroll-groups")).toBeVisible();

  await page.getByTestId("enroll-policy-domain").click();
  await expect(page.getByTestId("enroll-domain-input")).toBeVisible();

  const domain = `corp-${Date.now().toString(36)}.example.com`;
  await page.getByTestId("enroll-domain-input").fill(domain);
  await page.getByTestId("enroll-domain-add").click();
  const item = page.locator("[data-testid=enroll-domain-item]", { hasText: domain });
  await expect(item).toBeVisible({ timeout: 8000 }); // stays (selector not reset by the refetch)
  await expect(item).toContainText("_wikistead-challenge." + domain);
  await expect(item.getByTestId("enroll-domain-verify")).toBeVisible();

  await item.getByTestId("enroll-domain-remove").click();
  await sleep(400);
  await expect(page.locator("[data-testid=enroll-domain-item]", { hasText: domain })).toHaveCount(0);
});

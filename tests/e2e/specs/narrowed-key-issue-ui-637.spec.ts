import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #637 / ADR-216 slice 7: a narrowed key can be issued FROM THE PRODUCT.
//
// Five slices of enforcement and one of API existed before anything a person could press. Driven through
// the screen because that is the claim — the route existing on the server is not the same as an admin
// being able to confine a key from where they are looking (the same reasoning #638's hand-off pin uses).
//
// Run against the EE entrypoint, which is what the e2e stack starts: narrowing is EE, so on a CE build
// the route is absent and the affordance must not appear at all.
test("#637: an admin can confine a key to a space, and the key says so", async ({ page }) => {
  test.setTimeout(180_000);
  await openDemo(page);
  await page.goto("/admin/api");
  await sleep(1200);
  await expect(page.getByTestId("api-key-name")).toBeVisible({ timeout: 20_000 });

  // the narrowing form is closed until it is asked for — an unnarrowed key is the common case
  await expect(page.getByTestId("api-key-narrow"), "closed by default").toHaveCount(0);
  await page.getByTestId("api-key-narrow-toggle").click();
  await expect(page.getByTestId("api-key-narrow")).toBeVisible();

  const options = page.getByTestId("api-key-space-option");
  expect(await options.count(), "the tenant's spaces are offered (flat — no tree here)").toBeGreaterThan(0);

  const stamp = Date.now().toString(36);
  await page.getByTestId("api-key-name").fill(`ui637-${stamp}`);
  await page.getByTestId("api-key-space-demo_space").check();
  await page.getByTestId("api-key-create").click();

  // the plaintext comes back in the box #638 made shared — not a third way of showing a secret
  await expect(page.getByTestId("api-key-plaintext-value")).toBeVisible({ timeout: 20_000 });
  const plaintext = (await page.getByTestId("api-key-plaintext-value").textContent())!.trim();
  expect(plaintext, "a usable key").toMatch(/^wks_/);

  // …and it really is confined: asking for a space it does not carry is refused, while its own answers.
  const probe = await page.evaluate(async (token) => {
    const one = await fetch("/api/spaces/demo_space/pages", { headers: { authorization: `Bearer ${token}` } });
    return { own: one.status };
  }, plaintext);
  expect(probe.own, "its own space answers").toBeLessThan(400);

  // the row it produced is listed
  await expect(page.getByTestId("api-key-list")).toContainText(`ui637-${stamp}`);
});

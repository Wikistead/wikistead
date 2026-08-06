import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #658: a confined key is legible in the list, and the row does not grow to say so.
//
// The server half is pinned where the authorization is (`key-ledger-confinement-658`). What can only be
// measured in a browser is the shape: #579 and #603 both ruled that these rows stay one line, and a row
// of chips naming every space and verb is exactly what would break that. So this measures HEIGHT against
// an unconfined row in the same list — a number with a control, not a screenshot.
test("#658: the list marks a confined key without growing the row", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "en"); } catch { /* private */ } });
  await openDemo(page);
  await page.goto("/admin/api");
  await sleep(1200);
  await expect(page.getByTestId("api-key-name")).toBeVisible({ timeout: 20_000 });

  const stamp = Date.now().toString(36);

  // an unconfined key first — the control the height is compared against
  await page.getByTestId("api-key-name").fill(`led658-plain-${stamp}`);
  await page.getByTestId("api-key-create").click();
  await expect(page.getByTestId("api-key-plaintext-value")).toBeVisible({ timeout: 20_000 });
  const firstSecret = (await page.getByTestId("api-key-plaintext-value").textContent())!.trim();

  // …then a confined one, through the same form
  await page.getByTestId("api-key-narrow-toggle").click();
  await expect(page.getByTestId("api-key-narrow")).toBeVisible();
  await page.getByTestId("api-key-name").fill(`led658-confined-${stamp}`);
  await page.getByTestId("api-key-space-demo_space").check();
  await page.getByTestId("api-key-create").click();
  await expect
    .poll(async () => (await page.getByTestId("api-key-plaintext-value").textContent())?.trim(), { timeout: 20_000 })
    .not.toBe(firstSecret);

  const rowOf = (name: string) => page.locator('[data-testid="api-key-item"]', { hasText: name });
  const confined = rowOf(`led658-confined-${stamp}`);
  const plain = rowOf(`led658-plain-${stamp}`);
  await expect(confined).toBeVisible({ timeout: 10_000 });
  await expect(plain).toBeVisible();

  // the mark is there, and only on the confined one
  await expect(confined.getByTestId("api-key-confinement"), "a confined key says so").toHaveCount(1);
  await expect(plain.getByTestId("api-key-confinement"), "an unconfined key carries nothing").toHaveCount(0);

  const h = async (row: typeof confined) => (await row.boundingBox())!.height;
  const [a, b] = [await h(confined), await h(plain)];
  expect(a, `the confined row is no taller than the plain one (${a} vs ${b})`).toBeLessThanOrEqual(b + 1);
});

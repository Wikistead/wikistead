import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// Space icon: every space shows a visual with no input — the switcher renders a
// deterministic initials chip auto-generated from the name ("Demo Space" → "DS").
// (The text-glyph override was removed — a space icon is an uploaded image or initials.)
test("the space switcher shows an auto-generated initials icon", async ({ page }) => {
  await openDemo(page);
  const icon = page.getByTestId("space-icon");
  await expect(icon).toBeVisible();
  await expect(icon).toHaveText(/^DS$/); // initials of "Demo Space"
  expect(await icon.locator("img").count()).toBe(0); // auto = initials, not an image
});

// #6 image upload: a manager can set the space icon to an uploaded image (takes
// precedence over the glyph; default stays the initials). The bytes are served
// publicly and reach the page via the /api proxy. Cleans up so the initials tests
// above (which assert no <img>) stay valid on re-run.
test("space settings: upload an image icon, see it in settings + sidebar, then remove", async ({ page }) => {
  await openDemo(page); // demo_space active; dev member manages it
  await page.goto("/spaces/demo_space/settings/general");
  await page.waitForSelector("[data-testid=space-general]");
  await sleep(200);

  await page.setInputFiles("[data-testid=space-icon-image-input]", {
    name: "icon.png", mimeType: "image/png", buffer: Buffer.from(PNG_1x1, "base64"),
  });

  // the settings preview renders an <img> that actually loads (bytes via the API)
  const previewImg = page.locator("[data-testid=space-icon-preview] img");
  await expect(previewImg).toBeVisible({ timeout: 8000 });
  await expect
    .poll(async () => previewImg.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 8000 })
    .toBeGreaterThan(0);

  // the sidebar space chip (only on a page route, not the settings shell) becomes the image
  await openDemo(page);
  await expect(page.locator("[data-testid=space-icon] img")).toBeVisible({ timeout: 8000 });

  // remove via settings → revert to the initials chip (no <img>) in both places
  await page.goto("/spaces/demo_space/settings/general");
  await page.waitForSelector("[data-testid=space-general]");
  await page.getByTestId("space-icon-image-remove").click();
  await expect(page.locator("[data-testid=space-icon-preview] img")).toHaveCount(0, { timeout: 8000 });
  await openDemo(page);
  await expect(page.locator("[data-testid=space-icon] img")).toHaveCount(0, { timeout: 8000 });
});

import { test, expect } from "@playwright/test";

// #602 / ADR-206: a preset connection wears its provider's mark; a connection with no preset wears
// none. The marks were in the repo since #281 and wired only to the social path — so the same Google
// appeared two ways on one screen, and the one following Google's own guidance was the path being
// retired. The ruling retired that path outright (§3, option B), which makes the preset the single
// place a mark can come from.
test("#602: the sign-in button carries its provider's mark, and only when it has a preset", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("**/auth/login-options", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      // one preset connection and one without: the difference under test, in one render
      body: JSON.stringify({
        methods: ["oidc"],
        connections: [
          { id: "c-google", kind: "oidc", label: null, brand: "google" },
          { id: "c-custom", kind: "oidc", label: "Acme SSO", brand: null },
        ],
      }),
    }));
  await page.goto("/auth/login");
  await expect(page.getByTestId("login-signin")).toBeVisible({ timeout: 15_000 });

  // the primary button is the preset one: it draws a mark
  await expect(page.getByTestId("login-signin").locator("svg"), "a preset connection carries its mark").toHaveCount(1);
  await expect(page.getByTestId("login-signin")).toContainText(/Google/i);

  // the preset-less one is text only
  await page.getByTestId("login-more").click();
  const custom = page.getByTestId("login-conn-c-custom");
  await expect(custom).toBeVisible();
  await expect(custom).toContainText("Acme SSO");
  await expect(custom.locator("svg"), "no preset, no mark — a generic glyph would be decoration pretending to identify").toHaveCount(0);

  // and the retired path leaves nothing behind on this screen
  await expect(page.locator("[data-testid^=login-social]"), "the social block went with its route").toHaveCount(0);
});

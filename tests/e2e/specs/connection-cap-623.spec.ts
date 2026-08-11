import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #623 (ruling ③): at the connection cap, the add button says WHY it will not work instead of
// offering a click that can only 409 — #606's "button that always fails". The fortress is the server's
// refusal (`connection-cap-623` on the server suite drives the real POST); what is measured here is the
// SCREEN's half: the button disables at the cap the SERVER reports, and does not disable below it.
//
// Stubbed at the network (the #537 pattern): putting twenty real connections into the shared e2e
// tenant would flip every legacy single-row reader in the suite. The cap value in the stub is
// deliberately NOT 20 — the screen must follow the number the server sends, not a copy of the ruling.

const conn = (n: number) => ({
  id: `c-${n}`, kind: "oidc", issuer: `https://idp${n}.example`, clientId: `client-${n}`,
  hasSecret: false, scopes: "", redirectUri: "https://app.example/auth/callback", enabled: true,
  sort: n, label: `IdP ${n}`, preset: null, trustGroups: false, subjectPrefix: null,
  groupsClaim: null, mcpEnabled: false, mcpEnforceable: false,
});

async function openWith(page: Page, held: number, cap: number) {
  await page.route((u) => u.pathname === "/api/admin/connections", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify(Array.from({ length: held }, (_, n) => conn(n))) })
      : route.fallback());
  await page.route((u) => u.pathname === "/api/admin/login-methods", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    // The real response with only the cap overridden: hand-writing the whole view would quietly pin
    // this spec to today's shape of every unrelated field. Read as TEXT once and fulfil from parts —
    // `real.json()` consumes the body, and passing the then-disposed response to fulfill() threw
    // "Response has been disposed" on the second test of a run (measured; the first test won a race).
    const real = await route.fetch();
    const status = real.status();
    const body = JSON.parse(await real.text()) as { oidcConnectionCap?: number };
    body.oidcConnectionCap = cap;
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await openDemo(page);
  await page.goto("/admin/auth");
  await expect(page.getByTestId("admin-connection-add")).toBeVisible({ timeout: 20_000 });
  await sleep(300);
}

test("#623 ③: at the cap the add button is disabled and says why", async ({ page }) => {
  test.setTimeout(120_000);
  await openWith(page, 3, 3);
  await expect(page.getByTestId("admin-connection-add"), "the button still offers a click that can only 409")
    .toBeDisabled();
  // …and the reason carries the server's number, not the ruling's: the stubbed cap is 3.
  await expect(page.getByTestId("admin-connection-cap-note")).toBeVisible();
  await expect(page.getByTestId("admin-connection-cap-note"), "the note does not carry the cap the server sent")
    .toContainText("3");
});

test("#623 ③: below the cap the button works (the control)", async ({ page }) => {
  test.setTimeout(120_000);
  await openWith(page, 2, 3);
  await expect(page.getByTestId("admin-connection-add"), "a button that disables whatever the count proves nothing above")
    .toBeEnabled();
  await expect(page.getByTestId("admin-connection-cap-note")).toHaveCount(0);
});

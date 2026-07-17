import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";

// #431 the SAME user must show the SAME initials on every surface. In god-mode the header /
// author chips fell back to the sub ("dev-user" → "DE") while member surfaces read the members
// display name. God-mode now resolves its canonical identity through the dev bearer (/auth/me — the
// same display_name source), so the header derives initials from the display name, never the sub.
test("#431 god-mode header initials come from the canonical display name, not the sub", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-testid=user-menu]");
  // guarantee a display name distinct from the sub (the ADR-020 self override — same store the
  // members surfaces read), then reload so the session resolve picks it up
  await page.evaluate(async () => {
    await fetch("/api/me/settings", {
      method: "PATCH",
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ displayNameOverride: "Canonical Name" }),
    });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid=user-menu]");
  await expect
    .poll(async () => (await page.getByTestId("user-menu").innerText()).trim(), { timeout: 8000 })
    .toBe("CN"); // "Canonical Name" → CN; the sub fallback would read "DE" (dev-user)
  // cleanup: drop the override so other specs see the seed identity
  await page.evaluate(async () => {
    await fetch("/api/me/settings", {
      method: "PATCH",
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ displayNameOverride: null }),
    });
  });
});

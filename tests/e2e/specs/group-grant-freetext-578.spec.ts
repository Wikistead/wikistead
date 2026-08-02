import { test, expect } from "@playwright/test";

// #578 / ADR-201 rev3 OQ4: one control, both halves.
//
// The grant picker could only offer group names somebody already carried, so declaring a group before
// anyone from it had ever signed in was the one thing the mapping form could do and this could not.
// The ruling keeps that capability and refuses it a second screen: the picker takes a typed name too,
// and says when the name is one the IdP has not produced yet.
test("#578: a group can be named before anyone carries it, and it says so", async ({ page }) => {
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 10_000 });

  // the grantee-type control is a Select (#511: never a bare <select>) — open it and take "group"
  await page.getByTestId("space-grant-type").click();
  await page.getByRole("option", { name: /group/i }).click();

  const typed = `Engineering-${Date.now().toString(36)}`;
  const input = page.getByTestId("space-grant-group-name");
  await expect(input, "the typed half of the control exists").toBeVisible();
  await input.fill(typed);

  await expect(
    page.getByTestId("space-grant-group-unconfirmed"),
    "a name nobody carries reads as unconfirmed rather than looking like a known group",
  ).toBeVisible();

  // ...and Add is reachable with only the typed name (the old control required a selection)
  await expect(page.getByTestId("space-grant-add")).toBeEnabled();
});

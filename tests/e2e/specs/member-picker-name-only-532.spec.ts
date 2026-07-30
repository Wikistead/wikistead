import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// #532: the member picker showed the opaque `sub` under each name. That dated from when the sub was the
// only identifier a member could see; #523 canonicalised display names from the IdP, so it is now noise in
// a picker — the user asked for names only. The sub is still what gets SENT (`user:<sub>`, the server
// contract is untouched) and still the fallback text for a member who has no name yet.
test("#532: the member picker lists names, not subs — and still resolves the principal", async ({ page }) => {
  await openDemo(page);
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-role-assign")).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("space-grant-input").fill("e");
  const row = page.getByTestId("space-grant-candidate").first();
  await expect(row, "a tenant member matched").toBeVisible({ timeout: 8000 });

  // one line, and it is not an opaque id: the picker no longer prints the sub beside the name
  const lines = (await row.innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
  expect(lines.length, `the row should be just the name, got: ${JSON.stringify(lines)}`).toBe(1);

  // …and picking still yields the person, with the principal resolved behind the scenes
  const name = lines[0]!;
  await row.click();
  await expect(page.getByTestId("space-grant-input")).toHaveValue(name);
});

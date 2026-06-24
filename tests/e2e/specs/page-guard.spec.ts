import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// A page that doesn't exist / isn't accessible must NOT present an editable phantom
// surface. Every page belongs to a space (the page#space premise); a spaceless phantom
// could be typed into via collab but never published. The client shows a clear state
// instead of an empty editable editor (the dev-token used to fall back to "edit").
test("a non-existent page is not an editable phantom", async ({ page }) => {
  await openDemo(page); // establishes the member session
  await page.goto("/p/does-not-exist-xyz-123");
  await sleep(600);

  // the guard rendered (forbidden for an unknown page with no FGA grant; 404 if the row
  // is missing but access is inherited) — either way, a clear non-editable state
  await expect(page.locator("[data-testid=page-forbidden], [data-testid=page-not-found]")).toBeVisible();
  // and there is NO edit affordance / editable surface at all
  expect(await page.getByTestId("edit-toggle").count()).toBe(0);
  expect(await page.locator("[data-pane=preview] .cm-content").count()).toBe(0);
});

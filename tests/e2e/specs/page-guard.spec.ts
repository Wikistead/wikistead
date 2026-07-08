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

  // #262: the guard shows a UNIFORM "not found" — whether the page is missing OR the member lacks view
  // access, the client renders the SAME not-found state (existence-hiding; a "forbidden" message would leak
  // that the page exists). The old page-forbidden branch is gone.
  await expect(page.getByTestId("page-not-found")).toBeVisible();
  expect(await page.getByTestId("page-forbidden").count()).toBe(0);
  // and there is NO edit affordance / editable surface at all
  expect(await page.getByTestId("edit-toggle").count()).toBe(0);
  expect(await page.locator("[data-pane=preview] .cm-content").count()).toBe(0);
});

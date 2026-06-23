import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// Group C-D: multiple toasts must STACK visibly (newer in front, older offset behind),
// not render at the same spot where the newest fully hides the rest. Ark computes the
// stack geometry into CSS vars (--y/--scale/--z-index) on each toast; the toast CSS has
// to consume them. This asserts two coexisting toasts occupy DIFFERENT positions.
test("toasts stack visibly instead of fully overlapping", async ({ page }) => {
  await openDemo(page);
  // Work on a throwaway new page so renaming doesn't touch shared demo state.
  await page.getByTestId("new-page").click();
  await page.waitForURL(/\/p\/.+edit=1/);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(300);

  const rename = async (name: string) => {
    await page.getByTestId("page-title").click();
    await page.getByTestId("page-title-input").fill(name);
    await page.getByTestId("page-title-input").press("Enter");
  };
  // Two quick renames → two "Saved" toasts coexist (3s duration).
  await rename("Stack One");
  await sleep(150);
  await rename("Stack Two");

  // Sonner renders each toast as [data-sonner-toast]; it stacks natively.
  const toasts = page.locator("[data-sonner-toast]");
  await expect(toasts).toHaveCount(2, { timeout: 2000 });
  // Stacked → their top positions differ. A full overlap (the bug) would be identical.
  const tops = await toasts.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(2);
});

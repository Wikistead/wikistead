import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// #492: a transient failure of the boot-critical page-tree fetch (`GET /spaces/:id/pages`) used to render
// the sidebar as the "No pages yet" EMPTY state — `pages = pagesQ.data ?? []` conflates error/loading with
// genuinely empty. The fix distinguishes them: a failed fetch shows a retry affordance, not the empty text.
const pagesTree = /\/spaces\/[^/]+\/pages(\?|$)/;

test("#492: a FAILED page-tree fetch shows a retry affordance, not the empty state", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page); // authenticated, demo space active → the page tree renders

  // force every page-tree fetch (incl. the retries) to fail
  await page.route(pagesTree, (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"down"}' }));
  await page.reload();
  await page.waitForSelector("[data-testid=sidebar], [data-testid=sidebar-toggle]");

  // the sidebar surfaces the failure with a Retry control (retry:3 backoff means it can take a few seconds)
  await expect(page.getByTestId("sidebar-pages-error")).toBeVisible({ timeout: 25000 });
  // …and it must NOT be masquerading as the "No pages yet" empty state
  await expect(page.getByText("No pages yet", { exact: false })).toHaveCount(0);
});

test("#492: once the fetch recovers, Retry loads the tree (no manual reload needed)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);

  let fail = true;
  await page.route(pagesTree, (r) => {
    if (fail) return r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"down"}' });
    return r.continue();
  });
  await page.reload();
  await page.waitForSelector("[data-testid=sidebar], [data-testid=sidebar-toggle]");
  const retry = page.getByTestId("sidebar-pages-error").getByRole("button");
  await expect(retry).toBeVisible({ timeout: 25000 });

  // recover the endpoint, click Retry → the tree loads (the error affordance clears)
  fail = false;
  await retry.click();
  await expect(page.getByTestId("sidebar-pages-error")).toHaveCount(0, { timeout: 15000 });
});

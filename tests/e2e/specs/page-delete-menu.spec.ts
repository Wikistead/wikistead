import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const API = "http://dev.localhost:4010";

// #4: the page ⋯ menu offers Delete (view + edit) and Share (edit) to a manage-capable
// user (dev-user is the page creator → manage). Two-layer authz: the UI shows the items
// only when canManage; the server re-checks and 403s (covered in spaces-pages.test.ts).

test("edit-mode ⋯ offers Share and Delete (manage-capable user)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "menu-edit");
  await enterEdit(page);
  await page.click("[data-testid=page-overflow-trigger]");
  await expect(page.getByTestId("share-page")).toBeVisible(); // Share is in the ⋯ while editing
  await expect(page.getByTestId("delete-page")).toBeVisible(); // Delete too
});

test("view-mode ⋯ offers Delete (manage-capable user)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "menu-view");
  // view mode (default) — Share has its own button; Delete lives in the ⋯
  await page.click("[data-testid=page-overflow-trigger]");
  await expect(page.getByTestId("delete-page")).toBeVisible();
});

test("Delete from the ⋯ removes the page and navigates away", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, "menu-delete");

  await page.click("[data-testid=page-overflow-trigger]");
  await page.getByTestId("delete-page").click();
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await page.getByTestId("confirm-delete-page").click();

  // navigated off the deleted page (catch-all → /p/demo)
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 5000 }).not.toBe(`/p/${id}`);

  // the page is really gone server-side: GET no longer returns it. Delete removes the
  // FGA tuples too, so access is denied (403) before the existence (404) check — either
  // way it is no longer reachable.
  const status = await page.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/pages/${id}`, { headers: { Authorization: "Bearer dev-token" } });
    return r.status;
  }, { api: API, id });
  expect([403, 404]).toContain(status);
});

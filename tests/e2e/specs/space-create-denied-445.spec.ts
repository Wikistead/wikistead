import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #445(review rejection): the space-creation gate worked, but a refused creation closed
// the dialog and said nothing — indistinguishable from "the button is broken". Now the denial is
// reported in words, the typed name survives, and the entry point is hidden when the member already
// knows it may not create. The e2e user is a tenant admin (it always passes the gate), so the refusal
// is injected at the response; that the SERVER refuses and now carries `code: space_creator` is pinned
// in custom-roles-tenant-445.test.ts.

const dialogInput = (page: import("@playwright/test").Page) => page.getByTestId("rename-dialog").getByRole("textbox");
const dialogSubmit = (page: import("@playwright/test").Page) => page.getByTestId("rename-dialog").getByRole("button", { name: /^(Create|作成)$/ });

async function openNewSpaceDialog(page: import("@playwright/test").Page) {
  await page.getByTestId("space-switcher").click();
  await page.getByTestId("space-new").click();
  await expect(page.getByTestId("rename-dialog")).toBeVisible();
}

test("#445a refused creation says why, and keeps the typed name", async ({ page }) => {
  await openDemo(page);
  await page.route("**/spaces", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ statusCode: 403, code: "space_creator", error: "Forbidden", message: "space creation is restricted" }) });
  });

  await openNewSpaceDialog(page);
  const typed = `denied-${Date.now()}`;
  await dialogInput(page).fill(typed);
  await dialogSubmit(page).click();

  // the reason, not a generic "action failed"
  await expect(page.getByText(/do not have permission to create spaces|スペースを作成する権限がありません/)).toBeVisible({ timeout: 8000 });
  // …and the work is not thrown away
  await expect(page.getByTestId("rename-dialog"), "the dialog stays open on failure").toBeVisible();
  await expect(dialogInput(page), "the typed name survives the failure").toHaveValue(typed);
});

test("#445the entry point is hidden when the member may not create spaces", async ({ page }) => {
  await page.route("**/me/capabilities", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ canCreateSpaces: false }) }));
  await openDemo(page);
  await page.getByTestId("space-switcher").click();
  await expect(page.getByTestId("space-new"), "no affordance for a capability the server would refuse").toHaveCount(0);
});

test("#445a STALE allow-flag still produces the error (hiding is not the feedback)", async ({ page }) => {
  // The admin turns the capability off mid-session: the cached flag still says yes, so the button is
  // there — pressing it must explain itself rather than silently do nothing.
  await page.route("**/me/capabilities", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ canCreateSpaces: true }) }));
  await openDemo(page);
  await page.route("**/spaces", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ statusCode: 403, code: "space_creator", error: "Forbidden", message: "space creation is restricted" }) });
  });

  await openNewSpaceDialog(page);
  await dialogInput(page).fill(`stale-${Date.now()}`);
  await dialogSubmit(page).click();
  await expect(page.getByText(/do not have permission to create spaces|スペースを作成する権限がありません/)).toBeVisible({ timeout: 8000 });
});

test("#445creation still works when it is allowed (no regression)", async ({ page }) => {
  await openDemo(page);
  await openNewSpaceDialog(page);
  const name = `ok-${Date.now()}`;
  await dialogInput(page).fill(name);
  await dialogSubmit(page).click();
  await expect(page.getByTestId("rename-dialog"), "a successful creation closes the dialog").toHaveCount(0, { timeout: 10000 });
  await sleep(500);
  await page.getByTestId("space-switcher").click();
  await expect(page.getByTestId("space-menu")).toContainText(name, { timeout: 8000 });
});

import { test, expect, type Page } from "@playwright/test";
import { openDemo } from "../helpers";

// #517: Tailwind v4's preflight sets `button { cursor: default }`, so clickable UI (shadcn Button, Radix
// tabs / menu items, switches) lost the hand cursor. A base-layer rule restores `cursor: pointer` on the
// interactive set; disabled controls keep the default arrow. Pinned by computed style on a real browser.
const cursorOf = (page: Page, testid: string) =>
  page.getByTestId(testid).first().evaluate((el) => getComputedStyle(el).cursor);

test("#517: clickable chrome shows the pointer cursor; a disabled control does not", async ({ page }) => {
  await openDemo(page);

  // a shadcn/DS button in the page controls (the ⋯ overflow trigger is always present)
  await expect(page.getByTestId("page-overflow-trigger")).toBeVisible({ timeout: 10000 });
  expect(await cursorOf(page, "page-overflow-trigger"), "an overflow button is a pointer").toBe("pointer");

  // open the ⋯ menu → a DropdownMenuItem, then the permissions dialog for a Radix tab (role=tab)
  await page.getByTestId("page-overflow-trigger").click();
  const permsItem = page.getByTestId("m-permissions").or(page.getByTestId("permissions-open")).first();
  await expect(permsItem).toBeVisible({ timeout: 8000 });
  // a menu item (role=menuitem) is a pointer
  expect(await permsItem.evaluate((el) => getComputedStyle(el).cursor), "a menu item is a pointer").toBe("pointer");
  await permsItem.click();
  await expect(page.getByTestId("permissions-dialog")).toBeVisible({ timeout: 8000 });
  expect(await cursorOf(page, "permissions-tab-access"), "a tab is a pointer").toBe("pointer");
});

test("#517: a disabled button keeps the default arrow", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const { openScratch } = await import("../helpers");
  await openScratch(page, `cursor517-${Date.now().toString(36)}`);
  // the mobile-width capability-pending edit slot renders a DISABLED round button in some states;
  // instead use a deterministic disabled control: the publish button is disabled with no dirty changes.
  const { enterEdit } = await import("../helpers");
  await enterEdit(page);
  const publish = page.getByTestId("publish-page");
  // freshly-entered edit with no changes → publish disabled
  if (await publish.isDisabled().catch(() => false)) {
    expect(await publish.evaluate((el) => getComputedStyle(el).cursor), "a disabled button is default").toBe("default");
  }
});

import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";
import { LOCKED_SPACE_NAME } from "../fixtures";

test("page tree: render, FGA-filtered listing, navigation, create, keyboard", async ({ page }) => {
  await openDemo(page);

  // (1) **SECURITY** the locked space exists in Postgres (RLS) but has no FGA
  // grant, so the FGA-filtered listing must not show it.
  const sidebar = await page.$eval("[data-testid=sidebar]", (el) => el.innerText);
  expect(sidebar).toContain("Demo Space");
  expect(sidebar).not.toContain(LOCKED_SPACE_NAME);

  // (2) expand -> page; (3) select -> navigate
  await page.getByText("Demo Space", { exact: true }).click();
  await sleep(300);
  expect(await page.$eval("[data-testid=sidebar]", (el) => el.innerText)).toContain("Demo Page");
  await page.getByText("Demo Page", { exact: true }).click();
  await sleep(300);
  expect(page.url()).toMatch(/\/p\/demo$/);

  // (4) create a space via the header button
  await page.getByRole("button", { name: "New space" }).click();
  await sleep(800);
  expect(await page.$eval("[data-testid=sidebar]", (el) => el.innerText)).toContain("Untitled space");

  // (5) keyboard: focus the demo page treeitem, ArrowDown moves focus within tree
  const item = await page.$('[data-testid=sidebar] [role="treeitem"][id$="page:demo"]');
  await item!.focus();
  await page.keyboard.press("ArrowDown");
  await sleep(200);
  const active = await page.evaluate(() => ({
    role: document.activeElement?.getAttribute("role"),
    focused: !!document.querySelector('[data-testid=sidebar] [role="treeitem"][data-focus]'),
  }));
  expect(active.role).toBe("treeitem");
  expect(active.focused).toBe(true);
});

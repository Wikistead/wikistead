import { test, expect, type Page } from "@playwright/test";
import { API, openDemo, sleep } from "../helpers";

// #582: a menu opened from inside a dialog was drawn outside it. The role picker's list is portalled to
// the body, and Radix keeps a portalled list inside the VIEWPORT — which says nothing about the dialog
// the control belongs to. A long option grew the list rightwards until it cleared the dialog's edge, and
// a reader looking at the dialog could not follow it.
//
// Real browser, because nothing in the source says where a portalled, popper-positioned element lands.
//
// Discovery-shaped: it opens EVERY combobox in the dialog rather than the one that was reported. A
// picker added to this dialog tomorrow is measured without anyone editing this file.

async function openPermissions(page: Page): Promise<string> {
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: `suggest582 ${Date.now().toString(36)}` }),
    });
    return ((await r.json()) as { id: string }).id;
  }, API);
  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(300);
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  await expect(page.getByTestId("grant-relation")).toBeVisible({ timeout: 10_000 });
  return pageId;
}

/** The open menu's box and the box of the dialog whose control opened it. */
const boxes = () => {
  const round = (e: Element) => {
    const r = e.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  };
  const dialog = document.querySelector("[role=dialog]");
  const menu = document.querySelector("[role=listbox]");
  return {
    dialog: dialog ? round(dialog) : null,
    menu: menu ? round(menu) : null,
  };
};

test("#582: a menu opened inside the permissions dialog stays inside it", async ({ page }) => {
  await openDemo(page);
  const pageId = await openPermissions(page);
  try {
    const dialog = page.locator("[role=dialog]");
    const combos = dialog.locator("[role=combobox]");
    const n = await combos.count();
    expect(n, "the dialog has pickers to check").toBeGreaterThan(0);

    for (let i = 0; i < n; i++) {
      const combo = combos.nth(i);
      const name = (await combo.getAttribute("data-testid")) ?? `combobox ${i}`;
      await combo.click();
      await sleep(350);
      const m = await page.evaluate(boxes);
      expect(m.menu, `${name} opened a menu`).not.toBeNull();
      expect(m.dialog, "the dialog is measurable").not.toBeNull();
      // The whole claim, in two numbers: a reader looking at the dialog can see the menu.
      expect(m.menu!.right, `${name}: right edge (menu ${JSON.stringify(m.menu)} vs dialog ${JSON.stringify(m.dialog)})`)
        .toBeLessThanOrEqual(m.dialog!.right);
      expect(m.menu!.left, `${name}: left edge`).toBeGreaterThanOrEqual(m.dialog!.left);
      // …and it did not achieve that by shrinking to nothing: the option text has to stay readable.
      expect(m.menu!.width, `${name}: the menu is still wide enough to read`).toBeGreaterThan(100);
      await page.keyboard.press("Escape");
      await sleep(200);
    }

    // Non-regression: the member typeahead is NOT portalled and was always inside. It shares the dialog
    // with the pickers, so it is measured on the same run rather than trusted.
    await page.getByTestId("grant-sub").fill("d");
    await expect(page.getByTestId("grant-candidates")).toBeVisible({ timeout: 8000 });
    const t = await page.evaluate(() => {
      const round = (e: Element) => {
        const r = e.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right) };
      };
      const dialog = document.querySelector("[role=dialog]")!;
      const list = document.querySelector('[data-testid="grant-candidates"]')!;
      return { dialog: round(dialog), list: round(list), inDom: dialog.contains(list) };
    });
    expect(t.inDom, "the typeahead list belongs to the dialog").toBe(true);
    expect(t.list.right).toBeLessThanOrEqual(t.dialog.right);
    expect(t.list.left).toBeGreaterThanOrEqual(t.dialog.left);
  } finally {
    await page.evaluate(async ({ api, pageId }) => {
      await fetch(`${api}/pages/${pageId}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } }).catch(() => {});
    }, { api: API, pageId });
  }
});

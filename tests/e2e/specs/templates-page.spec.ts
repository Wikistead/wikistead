import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #249 / ADR-110: the /templates management page — a saved template appears with its scope badge and can
// be renamed and deleted. Real Chromium.
test("#249: a saved template appears on /templates and can be renamed and deleted", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const src = await openScratch(page, `tpl-mgmt-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Sprint template\n\n- goals\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  // Save it as a personal template via the ⋯ menu.
  await page.goto(`/p/${src}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("save-template-open").click();
  await page.getByTestId("template-name").fill("My sprint template");
  await page.getByTestId("save-template-submit").click();
  await sleep(500);

  // The management page lists it with a scope badge; owner can manage it.
  await page.goto("/templates");
  await page.waitForSelector("[data-testid=templates-page]");
  const row = page.getByTestId("template-row").filter({ hasText: "My sprint template" }).first();
  await expect(row).toBeVisible({ timeout: 8000 });
  await expect(row.getByTestId("template-scope-badge")).toBeVisible();

  // Rename it.
  await row.getByTestId("template-rename").click();
  const input = page.locator("[data-testid=rename-dialog] input").first();
  await input.fill("Renamed sprint template");
  await page.keyboard.press("Enter");
  await sleep(500);
  await expect(page.getByTestId("template-row").filter({ hasText: "Renamed sprint template" }).first()).toBeVisible({ timeout: 8000 });

  // Delete it → confirm → gone.
  const row2 = page.getByTestId("template-row").filter({ hasText: "Renamed sprint template" }).first();
  await row2.getByTestId("template-delete").click();
  await page.getByTestId("confirm-delete").click();
  await sleep(600);
  await expect(page.getByTestId("template-row").filter({ hasText: "Renamed sprint template" })).toHaveCount(0);
});

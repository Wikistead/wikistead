import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #248 / ADR-110: the "Save as template" dialog — save a published page's content as a reusable template
// with a scope (personal default), and a shared-scope warning. Real Chromium.
test("#248: Save as template — dialog, scope warning, and save", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tpl-save-src");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Weekly report\n\n- wins\n- risks\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  // Open ⋯ → Save as template.
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("save-template-open").click();
  await expect(page.getByTestId("save-template-dialog")).toBeVisible();

  // Default name follows the page title; personal scope is default (no warning).
  await expect(page.getByTestId("template-name")).toHaveValue("tpl-save-src");
  await expect(page.getByTestId("template-scope-personal")).toBeChecked();
  await expect(page.getByTestId("template-scope-warning")).toHaveCount(0);

  // Choosing a shared scope reveals the re-publish warning; back to personal hides it.
  await page.getByTestId("template-scope-tenant").check();
  await expect(page.getByTestId("template-scope-warning")).toBeVisible();
  await page.getByTestId("template-scope-personal").check();
  await expect(page.getByTestId("template-scope-warning")).toHaveCount(0);

  // Save → the dialog closes (success).
  await page.getByTestId("template-name").fill("My weekly template");
  await page.getByTestId("save-template-submit").click();
  await expect(page.getByTestId("save-template-dialog")).toHaveCount(0, { timeout: 5000 });
});

// #248: a draft-only page (never published) shows the item GRAYED OUT (a template snapshots published_md).
test("#248: Save as template is disabled for a draft-only page", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tpl-save-draft");
  // do NOT publish — the page stays a draft.
  await page.getByTestId("page-overflow-trigger").click();
  const item = page.getByTestId("save-template-open");
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("data-disabled", /.*/); // radix disabled item carries data-disabled
});

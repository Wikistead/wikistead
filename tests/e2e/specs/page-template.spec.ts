import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #229/#242: "Duplicate page" (⋯ menu) creates a NEW page seeded with the current page's published
// content and opens it in edit mode. Real Chromium.
test("#242: 'Duplicate page' creates a new page pre-filled with the source content", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const tmpl = await openScratch(page, "tmpl-src");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Weekly Sync\n\n- roundtable\n- blockers\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  // Open the ⋯ menu and click "Duplicate page".
  await page.goto(`/p/${tmpl}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("duplicate-page").click();
  // Navigated to a NEW page (?edit=1) whose content is the template body.
  await page.waitForURL(/\/p\/(?!.*tmpl-src).+\?edit=1/, { timeout: 8000 }).catch(() => {});
  await sleep(1200);
  const url = page.url();
  expect(url).toContain("edit=1");
  expect(url).not.toContain(tmpl); // a different page id
  const body = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(body).toContain("Weekly Sync");
  expect(body).toContain("roundtable");
});

// #242 (review follow-up): the same "Duplicate page" is reachable from the SIDEBAR page row
// ⋯ menu (page-actions), not just the page-body overflow menu. Real Chromium.
test("#242: 'Duplicate page' from the sidebar tree row ⋯ menu seeds a new page", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const srcTitle = `tree-dup-${Date.now()}`;
  const src = await openScratch(page, srcTitle);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Sidebar Dup\n\n- alpha\n- beta\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  // Reload so the sidebar tree reflects the new page, then act via the row ⋯ menu.
  await page.goto(`/p/${src}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(500);
  const row = page.getByTestId("tree-page").filter({ hasText: srcTitle }).first();
  await row.hover();
  await row.getByTestId("page-actions").click();
  await page.getByTestId("tree-duplicate-page").click();

  // Navigated to a NEW page (?edit=1) whose content is the source body.
  await page.waitForURL(/\?edit=1/, { timeout: 8000 }).catch(() => {});
  await sleep(1200);
  const url = page.url();
  expect(url).toContain("edit=1");
  expect(url).not.toContain(src); // a different page id
  const body = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(body).toContain("Sidebar Dup");
  expect(body).toContain("alpha");
});

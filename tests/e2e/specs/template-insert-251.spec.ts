import { test, expect, type Page } from "@playwright/test";
import { openScratch, openDemo, enterEdit, sleep, API } from "../helpers";

// #251 / ADR-110: the "/"-palette "Insert template" command. Selecting it opens the picker (the same
// list/preview asset as the #250 sidebar picker); choosing a template INSERTS its body at the caret — it
// does NOT replace the page, and the title is untouched. Real Chromium.
test("#251: slash 'insert template' inserts the template body at the caret, non-destructively", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();

  // Make a personal template from a published page.
  const src = await openScratch(page, `ins-src-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Inserted heading\n\n- alpha\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);
  await page.goto(`/p/${src}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("save-template-open").click();
  await page.getByTestId("template-name").fill("Snippet");
  await page.getByTestId("save-template-submit").click();
  await sleep(500);

  // On a fresh page, type some existing content, then insert the template via the "/" palette.
  await openScratch(page, `ins-host-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("Existing line\n");
  await sleep(200);

  await page.keyboard.type("/template");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-insert-template"]');

  // The picker opens; choose the template and use it.
  await expect(page.getByTestId("template-picker")).toBeVisible();
  const item = page.getByTestId("template-picker-item").filter({ hasText: "Snippet" }).first();
  await expect(item).toBeVisible({ timeout: 8000 });
  await item.click();
  await page.getByTestId("template-picker-use").click();
  await sleep(400);

  // The body was inserted at the caret; the original content is preserved (non-destructive).
  const content = page.locator("[data-pane=preview] .cm-content");
  await expect(content).toContainText("Existing line");
  await expect(content).toContainText("Inserted heading");
  await expect(content).toContainText("alpha");
});

async function editShareUrl(page: Page, pageId: string): Promise<string> {
  const id = await page.evaluate(async ({ api, pageId }) => {
    const r = await fetch(`${api}/share-links`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ resource: { type: "page", id: pageId }, capability: "edit", expiresInSeconds: null }),
    });
    return (await r.json()).id as string;
  }, { api: API, pageId });
  return `/share/${id}`;
}

// #916: templates are member-only (ADR-110 — no `config.guest`, so a guest's pick 403s and the picker
// opens on nothing). The palette command's presence is gated on the host wiring the picker seam
// (Editor.tsx's openTemplateInsertPicker); guestSurface must withhold it. Real Chromium.
test("#916: an edit-share guest's slash palette has no 'insert template' command", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await member.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ title: `guest-tpl-916-${Date.now()}` }),
    });
    return (await r.json()).id as string;
  }, API);
  const url = await editShareUrl(member, pageId);

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  await guest.waitForSelector("[data-pane=preview] .cm-content", { timeout: 10000 });
  await sleep(800);
  await enterEdit(guest);
  await sleep(500);
  await guest.click("[data-pane=preview] .cm-content");
  await guest.keyboard.insertText("Existing line\n");
  await sleep(300);

  // A bare "/" opens the palette with the full (unfiltered) command list — the item must
  // be absent from that list, not merely unmatched by a "template" query (which, with the
  // command withheld, matches nothing and never opens the palette at all).
  await guest.keyboard.type("/");
  await expect(guest.getByTestId("slash-palette")).toBeVisible({ timeout: 8000 });
  await expect(guest.getByTestId("slash-item-insert-template")).toHaveCount(0);
});

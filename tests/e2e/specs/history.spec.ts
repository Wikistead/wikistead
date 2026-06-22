import { test, expect } from "@playwright/test";
import { openDemo, enterEdit, paneText, sleep } from "../helpers";

// 2e-2 + 2f-1: page history & restore. In the draft/publish model a revision is
// created by an explicit PUBLISH (the auto-snapshot was removed); history IS the
// publish history. So we author "ALPHA", PUBLISH it (→ one revision holding ALPHA),
// then add "BETA" to the draft (published stays ALPHA). Restoring the revision
// reverts the OPEN editor live (Valkey propagation), with no reload.
const API = "http://dev.localhost:4010";

test("history: a revision is listed and restoring it reverts the live editor", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "history page" }),
    });
    return (await r.json()).id as string;
  }, API);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");

  // (1) author "ALPHA", let the draft persist (collab debounce), then PUBLISH it via
  // API (publish snapshots the persisted draft → creates the single revision).
  await page.keyboard.type("ALPHA");
  await sleep(2800);
  await page.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId });
  await expect
    .poll(
      async () =>
        page.evaluate(async ({ api, pageId }) => {
          const r = await fetch(`${api}/pages/${pageId}/revisions`, { headers: { Authorization: "Bearer dev-token" } });
          return ((await r.json()) as unknown[]).length;
        }, { api: API, pageId }),
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(1);

  // (2) add " BETA" to the draft — diverges from the published revision (no new
  // publish). Wait past the 2s store debounce so restore's delta sees "ALPHA BETA".
  await page.keyboard.type(" BETA");
  await sleep(2800);
  expect(await paneText(page, "preview")).toContain("BETA");

  // (3) open History → the published revision is listed; restore it (confirm dialog).
  await page.click("[data-testid=history-toggle]");
  await expect(page.locator("[data-testid=history-panel]")).toBeVisible();
  await expect(page.locator("[data-testid=revision-item]").first()).toBeVisible();
  await page.locator("[data-testid=revision-restore]").first().click();
  await page.locator("[data-testid=confirm-dialog] [data-testid=confirm-restore]").click();

  // (4) the open editor reverts live to the snapshot ("ALPHA", no "BETA") — no reload.
  await expect.poll(async () => paneText(page, "preview"), { timeout: 10_000 }).toContain("ALPHA");
  expect(await paneText(page, "preview")).not.toContain("BETA");
});

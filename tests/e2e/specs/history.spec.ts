import { test, expect } from "@playwright/test";
import { openDemo, enterEdit, paneText, sleep } from "../helpers";

// 2e-2: page history & restore UI wiring the Phase-0 revisions backend (GET list /
// POST restore). The first persisted store always snapshots a revision (the 5-min
// interval gate sees no prior snapshot); a later edit within the window does not.
// So we author "ALPHA", wait for its snapshot, then add "BETA" — the single
// revision holds "ALPHA". Restoring it reverts the OPEN editor live (Valkey
// propagation), with no reload.
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

  // (1) author "ALPHA" and wait until its snapshot is persisted (poll the API).
  await page.keyboard.type("ALPHA");
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

  // (2) add " BETA" — current content diverges from the snapshot (no new revision
  // yet: within the 5-min interval). Wait past the 2s store debounce.
  await page.keyboard.type(" BETA");
  await sleep(2800);
  expect(await paneText(page, "preview")).toContain("BETA");

  // (3) open History → the revision is listed; restore it (confirm dialog).
  await page.click("[data-testid=history-toggle]");
  await expect(page.locator("[data-testid=history-panel]")).toBeVisible();
  await expect(page.locator("[data-testid=revision-item]").first()).toBeVisible();
  await page.locator("[data-testid=revision-restore]").first().click();
  await page.locator("[data-testid=confirm-dialog] [data-testid=confirm-restore]").click();

  // (4) the open editor reverts live to the snapshot ("ALPHA", no "BETA") — no reload.
  await expect.poll(async () => paneText(page, "preview"), { timeout: 10_000 }).toContain("ALPHA");
  expect(await paneText(page, "preview")).not.toContain("BETA");
});

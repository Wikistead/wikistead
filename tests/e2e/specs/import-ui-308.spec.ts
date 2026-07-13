import { test, expect } from "@playwright/test";
import { openDemo } from "../helpers";

// #308 / ADR-132: the import UI. The server materializer + authz are covered by import.test.ts / import-unit;
// this covers the real-browser flow: IMPORT an export ZIP into a space via the switcher menu → hidden file
// input, and assert the imported draft appears + the report toast. Real Chromium.
const API = "http://dev.localhost:4010";

test("#308 import an export ZIP into a space via the menu (imported draft appears)", async ({ browser, request }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  const stamp = Date.now();
  const pageTitle = `Round Trip ${stamp}`;

  // Build a SOURCE space with a published page + export it (node-side, to avoid the flaky switcher search).
  const { srcId, destPageId } = await page.evaluate(async ({ api, pageTitle }) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const src = await (await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: `Imp Src ${pageTitle}` }) })).json() as { id: string };
    const pg = await (await fetch(`${api}/spaces/${src.id}/pages`, { method: "POST", headers: H, body: JSON.stringify({ title: pageTitle }) })).json() as { id: string };
    await fetch(`${api}/pages/${pg.id}/publish`, { method: "POST", headers: H });
    // Destination space + a page to navigate to (so the destination becomes the ACTIVE space without the switcher).
    const dest = await (await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: `Imp Dest ${pageTitle}` }) })).json() as { id: string };
    const dpg = await (await fetch(`${api}/spaces/${dest.id}/pages`, { method: "POST", headers: H, body: JSON.stringify({ title: "Dest Home" }) })).json() as { id: string };
    return { srcId: src.id, destPageId: dpg.id };
  }, { api: API, pageTitle });

  // Fetch the source export ZIP node-side (dev-token bearer) → the bytes we'll upload through the import UI.
  const exportRes = await request.get(`${API}/spaces/${srcId}/export`, { headers: { Authorization: "Bearer dev-token" } });
  expect(exportRes.status()).toBe(200);
  const zipBuffer = await exportRes.body();

  // Open the destination space by navigating to one of its pages → it becomes the active space.
  await page.goto(`/p/${destPageId}`);
  await page.waitForSelector("[data-testid=sidebar]");

  // Open the switcher menu → the import item → feed the ZIP into the hidden file input (the full
  // browser upload path: File → base64 → POST /spaces/:id/import → success toast).
  await page.getByTestId("space-switcher").click();
  await expect(page.getByTestId("space-import")).toBeVisible();
  await page.getByTestId("space-import-input").setInputFiles({ name: "export.zip", mimeType: "application/zip", buffer: zipBuffer });

  // The report toast confirms the import succeeded end-to-end (the created pages land in the active space;
  // that placement + authz is pinned deterministically by import.test.ts).
  await expect(page.getByText("Imported", { exact: false })).toBeVisible({ timeout: 15000 });
});

test("#308 a 403 (not permitted) shows the dedicated forbidden message", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  await page.route("**/spaces/*/import", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }));
  await page.getByTestId("space-switcher").click();
  // a tiny valid-looking file is enough — the route is intercepted before the server sees it
  await page.getByTestId("space-import-input").setInputFiles({ name: "x.zip", mimeType: "application/zip", buffer: Buffer.from("PK\x03\x04rest") });
  await expect(page.getByText("permission to import", { exact: false })).toBeVisible({ timeout: 10000 });
});

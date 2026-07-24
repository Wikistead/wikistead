import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { openDemo, sleep, API } from "../helpers";

// #309 (bounce): UI entry points for the space / tenant Markdown-ZIP exports. The server
// endpoints + authz were verified in export.test.ts; this covers the CLICK → real browser download
// → ZIP structure path, plus the dedicated 413 (size budget) message. Real Chromium downloads.
async function makeSpaceWithPublishedPage(page: Page, spaceName: string, pageTitle: string): Promise<{ spaceId: string }> {
  return page.evaluate(async ({ api, spaceName, pageTitle }) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const sp = await (await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: spaceName }) })).json() as { id: string };
    const pg = await (await fetch(`${api}/spaces/${sp.id}/pages`, { method: "POST", headers: H, body: JSON.stringify({ title: pageTitle }) })).json() as { id: string };
    // a page appears in the archive as <title>/index.md even when its published body is empty
    // (published-only semantics) — no need to author content for the structure assert.
    await fetch(`${api}/pages/${pg.id}/publish`, { method: "POST", headers: H });
    return { spaceId: sp.id };
  }, { api: API, spaceName, pageTitle });
}

async function zipEntriesOf(download: import("@playwright/test").Download): Promise<string[]> {
  const path = await download.path();
  const entries = unzipSync(new Uint8Array(readFileSync(path!)));
  return Object.keys(entries);
}

test("#309 space export: switcher menu item downloads a ZIP with <root-page>/index.md", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  const spaceName = `Export Space ${Date.now()}`;
  const pageTitle = "Exported Page";
  await makeSpaceWithPublishedPage(page, spaceName, pageTitle);
  await page.reload();
  await page.waitForSelector("[data-testid=sidebar]");

  // switch to the new space via the switcher search
  await page.getByTestId("space-switcher").click();
  await page.getByTestId("space-search").fill(spaceName);
  await page.getByTestId("space-option").first().click();
  await sleep(400);

  // open the switcher again → Export space → a real download starts
  await page.getByTestId("space-switcher").click();
  const dl = page.waitForEvent("download");
  await page.getByTestId("space-export").click();
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const names = await zipEntriesOf(download);
  // the root page is a top-level directory with its Markdown as index.md
  expect(names.some((n) => n.includes("Exported") && n.endsWith("index.md")), `entries: ${names.join(", ")}`).toBe(true);
  await expect(page.getByText("Export downloaded")).toBeVisible();
});

test("#309 tenant export: the account Data section downloads a ZIP with <space>/<page>/index.md", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  const spaceName = `Tenant Export ${Date.now()}`;
  await makeSpaceWithPublishedPage(page, spaceName, "Tenant Page");

  await page.goto("/settings/account/data");
  await expect(page.getByTestId("tenant-export-card")).toBeVisible();
  const dl = page.waitForEvent("download");
  await page.getByTestId("tenant-export").click();
  // the button disables + spins while the archive is generated
  await expect(page.getByTestId("tenant-export")).toBeDisabled();
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const names = await zipEntriesOf(download);
  // spaces are top-level directories; our fresh space's page is inside it
  const hit = names.find((n) => n.includes("Tenant-Export") || n.includes("Tenant Export"));
  expect(hit, `no entry for the created space; sample: ${names.slice(0, 10).join(", ")}`).toBeTruthy();
  expect(names.some((n) => n.endsWith("index.md"))).toBe(true);
  await expect(page.getByTestId("tenant-export")).toBeEnabled();
});

test("#309 a 413 (size budget) shows the DEDICATED too-large message, not the generic error", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  // intercept the export call and simulate the server's size-budget rejection
  await page.route("**/spaces/*/export", (route) => route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: "export too large" }) }));
  await page.getByTestId("space-switcher").click();
  await page.getByTestId("space-export").click();
  await expect(page.getByText("The export exceeds the size limit", { exact: false })).toBeVisible();
});

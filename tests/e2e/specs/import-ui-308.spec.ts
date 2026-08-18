import { test, expect } from "@playwright/test";
import { openDemo, API } from "../helpers";

// #308 / ADR-132 + #725 / ADR-236: the import surface, in a real browser.
//
// It used to be a hidden file input behind a switcher item whose only output was a toast of two
// numbers. #725 moved the work onto a screen (space settings → Import) because the fidelity report
// ADR-227 produces has to be READ: it names what did not survive, page by page, and a toast cannot
// carry that. So these drive the screen: the menu item navigates to it, an upload lands there, and the
// report on it names things rather than counting them.
test("#725 import an export ZIP through the import screen (report names what happened)", async ({ browser, request }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  const stamp = Date.now();
  const pageTitle = `Round Trip ${stamp}`;

  // Build a SOURCE space with a published page + export it (node-side, to avoid the flaky switcher search).
  const { srcId, destId, destPageId } = await page.evaluate(async ({ api, pageTitle }) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const src = await (await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: `Imp Src ${pageTitle}` }) })).json() as { id: string };
    const pg = await (await fetch(`${api}/spaces/${src.id}/pages`, { method: "POST", headers: H, body: JSON.stringify({ title: pageTitle }) })).json() as { id: string };
    await fetch(`${api}/pages/${pg.id}/publish`, { method: "POST", headers: H });
    const dest = await (await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: `Imp Dest ${pageTitle}` }) })).json() as { id: string };
    const dpg = await (await fetch(`${api}/spaces/${dest.id}/pages`, { method: "POST", headers: H, body: JSON.stringify({ title: "Dest Home" }) })).json() as { id: string };
    return { srcId: src.id, destId: dest.id, destPageId: dpg.id };
  }, { api: API, pageTitle });

  const exportRes = await request.get(`${API}/spaces/${srcId}/export`, { headers: { Authorization: "Bearer dev-token" } });
  expect(exportRes.status()).toBe(200);
  const zipBuffer = await exportRes.body();

  // Open the destination space by navigating to one of its pages → it becomes the active space.
  await page.goto(`/p/${destPageId}`);
  await page.waitForSelector("[data-testid=sidebar]");

  // The switcher entry still exists, and now it OPENS THE SCREEN rather than doing the import from a
  // hidden input. Landing on the tab is the assertion.
  await page.getByTestId("space-switcher").click();
  await page.getByTestId("space-import").click();
  await expect(page).toHaveURL(new RegExp(`/spaces/${destId}/settings/import`));
  await expect(page.getByTestId("space-import-screen")).toBeVisible();
  await expect(page.getByTestId("space-import-input")).toBeAttached();

  // Upload through the screen: File → base64 → POST /spaces/:id/import → the report renders here.
  await page.getByTestId("space-import-input").setInputFiles({ name: "export.zip", mimeType: "application/zip", buffer: zipBuffer });
  await page.getByTestId("import-start").click();

  const report = page.getByTestId("import-report");
  await expect(report).toBeVisible({ timeout: 30000 });
  // The draft default is on the report in words: this archive is imported unpublished, and the read
  // surface will say the pages are empty until somebody publishes them.
  await expect(page.getByTestId("import-draft-notice")).toBeVisible();
  // …and the imported page is really there, under the destination space.
  await page.getByTestId("import-open-space").click();
  await expect(page.getByText(pageTitle, { exact: false }).first()).toBeVisible({ timeout: 15000 });
});

test("#725 a degradation is shown by NAME on the report, not as a count", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  // The server's own report, stubbed: this spec is about what the SCREEN does with a report that has
  // degradations in it, and a real archive that degrades in a chosen way would be a fixture pinned to
  // adapter internals. The report shape is the server's DTO (ImportReport).
  await page.route("**/spaces/*/import", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      degraded: [
        { node: "Weekly Review", what: "Dataview query", detail: "table from #daily" },
        { node: "Sketches", what: "Canvas file" },
      ],
      pagesCreated: 2, emptyPagesCreated: 0, attachmentsImported: 0,
      attachmentsSkipped: [{ name: "big.psd", reason: "storage quota" }],
      deadCrossLinks: 1, published: 0, lossyTitles: true,
    }),
  }));

  const spaceId = await page.evaluate(async (api) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const s = await (await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: `Imp Names ${Date.now()}` }) })).json() as { id: string };
    return s.id;
  }, API);

  await page.goto(`/spaces/${spaceId}/settings/import`);
  await page.getByTestId("space-import-input").setInputFiles({ name: "x.zip", mimeType: "application/zip", buffer: Buffer.from("PK\x03\x04rest") });
  await page.getByTestId("import-start").click();

  await expect(page.getByTestId("import-report")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Weekly Review", { exact: false })).toBeVisible();
  await expect(page.getByText("Sketches", { exact: false })).toBeVisible();
  await expect(page.getByText("big.psd", { exact: false })).toBeVisible();
});

test("#725 a 403 (not permitted) shows the dedicated forbidden message", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  await page.route("**/spaces/*/import", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }));
  const spaceId = await page.evaluate(async (api) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const s = await (await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: `Imp 403 ${Date.now()}` }) })).json() as { id: string };
    return s.id;
  }, API);
  await page.goto(`/spaces/${spaceId}/settings/import`);
  await page.getByTestId("space-import-input").setInputFiles({ name: "x.zip", mimeType: "application/zip", buffer: Buffer.from("PK\x03\x04rest") });
  await page.getByTestId("import-start").click();
  await expect(page.getByText("permission to import", { exact: false })).toBeVisible({ timeout: 10000 });
});

// ADR-236 §3: the report outlives the connection that started it, so a RELOAD mid-import has to come
// back to the same import. The id is in the URL for exactly this; a screen holding it in memory would
// pass every other test here and fail this one.
test("#725 a queued (202) import survives a reload and resumes on the same import", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  const spaceId = await page.evaluate(async (api) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const s = await (await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: `Imp 202 ${Date.now()}` }) })).json() as { id: string };
    return s.id;
  }, API);

  await page.route("**/spaces/*/import", (route) => route.fulfill({
    status: 202, contentType: "application/json",
    body: JSON.stringify({ importId: "imp_e2e_1", status: "queued", nodesTotal: 900 }),
  }));
  // The job row: still running on the first reads, done afterwards. Served by the stub so the spec
  // does not need a 900-page archive to exercise the path that only large archives take.
  let polls = 0;
  await page.route("**/spaces/*/imports/imp_e2e_1", (route) => {
    polls += 1;
    const done = polls > 3;
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        id: "imp_e2e_1", status: done ? "done" : "running", nodesTotal: 900, nodesDone: done ? 900 : 120,
        report: done ? { degraded: [{ node: "Weekly Review", what: "Dataview query" }], pagesCreated: 900, emptyPagesCreated: 0, attachmentsImported: 0, attachmentsSkipped: [], deadCrossLinks: 0, published: 0, lossyTitles: false } : null,
        error: null,
      }),
    });
  });

  await page.goto(`/spaces/${spaceId}/settings/import`);
  await page.getByTestId("space-import-input").setInputFiles({ name: "big.zip", mimeType: "application/zip", buffer: Buffer.from("PK\x03\x04rest") });
  await page.getByTestId("import-start").click();

  await expect(page.getByTestId("import-running")).toBeVisible({ timeout: 15000 });
  // Generous: on a cold dev server the first upload of a run has been measured taking tens of seconds
  // to come back, and the default 5 s here failed on that alone while passing in isolation.
  await expect(page).toHaveURL(/import=imp_e2e_1/, { timeout: 20000 });

  // The reload: nothing in memory, the id in the address bar. What is asserted is the RESUMPTION —
  // the same import id survives and its report arrives here — not the exact frame the reload lands on
  // (whether it is still running by then is a race, and racing on it would make this spec flaky).
  await page.reload();
  await expect(page).toHaveURL(/import=imp_e2e_1/, { timeout: 20000 });
  await expect(page.getByTestId("import-report")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Weekly Review", { exact: false })).toBeVisible();
});

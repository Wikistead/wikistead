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
  // #746 turned publishing on by default, and this round-trip STILL reports drafts — correctly. The
  // source page here is created by the API and never typed into, so its published Markdown is empty,
  // and the materializer does not publish an empty body (there is nothing to publish). So the draft
  // sentence is the right one on this report, and it is asserted rather than removed: measured, not
  // assumed, because "the default changed" would otherwise have been reason enough to delete a line
  // that is still true. The default itself is pinned where real content goes through the shipped route
  // (server: import-publish-default-746), and the OFF branch by the spec below.
  await expect(page.getByTestId("import-draft-notice")).toBeVisible();
  // …and the imported page is really there, under the destination space.
  await page.getByTestId("import-open-space").click();
  await expect(page.getByText(pageTitle, { exact: false }).first()).toBeVisible({ timeout: 15000 });
});

// #746: the other half of the ruling — the choice was kept, only its default moved. Driven through the
// real switch, because "the switch still works" is the claim, and a stubbed report cannot make it.
const BODY = "# Draft Me" + String.fromCharCode(10) + String.fromCharCode(10) + "Quietly, please." + String.fromCharCode(10);

test("#746 turning publishing off still brings the archive in as drafts", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  const spaceId = await page.evaluate(async (api) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const s = await (await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: `Imp Draft ${Date.now()}` }) })).json() as { id: string };
    return s.id;
  }, API);

  await page.goto(`/spaces/${spaceId}/settings/import`);
  await expect(page.getByTestId("import-publish")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("import-publish").click();
  await expect(page.getByTestId("import-publish"), "the switch turns off").toHaveAttribute("aria-checked", "false");

  await page.getByTestId("space-import-input").setInputFiles({
    name: "quiet.zip", mimeType: "application/zip",
    // A real zip of one Markdown file: stored (no compression), which the importer accepts.
    buffer: zipOne("Draft Me.md", Buffer.from(BODY, "utf8")),
  });
  await page.getByTestId("import-start").click();

  await expect(page.getByTestId("import-report")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("import-draft-notice"), "the line that explains the empty page is here")
    .toBeVisible();
  await expect(page.getByTestId("import-published-notice")).toHaveCount(0);
});

/** A minimal STORED-method zip of a single file — enough for the importer, with no fixture on disk. */
function zipOne(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const crcTable = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const centralStart = local.length + nameBuf.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12); end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([local, nameBuf, data, central, nameBuf, end]);
}

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

// #725① (review rejection): a 409 says WHICH import is already running, and the screen walks onto
// it. Before #712the body carried no id, so the screen could only say "busy, reload later"
// while the progress it was describing was one link away. The reject was that the id had landed and
// the screen still ignored it.
test("#725 a 409 walks onto the import that is already running", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  const spaceId = await page.evaluate(async (api) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const s = await (await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: `Imp 409 ${Date.now()}` }) })).json() as { id: string };
    return s.id;
  }, API);

  await page.route("**/spaces/*/import", (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({
      error: "an import is already running for this space",
      running: { id: "imp_busy_1", status: "running", nodesDone: 120, nodesTotal: 900 },
    }),
  }));
  await page.route("**/spaces/*/imports/imp_busy_1", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "imp_busy_1", status: "running", nodesTotal: 900, nodesDone: 120, report: null, error: null }),
  }));

  await page.goto(`/spaces/${spaceId}/settings/import`);
  await page.getByTestId("space-import-input").setInputFiles({ name: "second.zip", mimeType: "application/zip", buffer: Buffer.from("PK\x03\x04rest") });
  await page.getByTestId("import-start").click();

  // The address bar is the assertion: the id has to reach the URL, because that is what makes the
  // running import shareable, reloadable and reachable from a second tab (ADR-236 §3).
  await expect(page).toHaveURL(/import=imp_busy_1/, { timeout: 20000 });
  await expect(page.getByTestId("import-running")).toBeVisible({ timeout: 15000 });
});

// #725③: measured on the RENDERED page, because the report was that this link did not LOOK
// like one — same colour as the body text and no underline. A class-name assertion cannot answer
// that (an undefined Tailwind token compiles to nothing and the test stays green, #535); the
// browser's own computed style can.
test("#725 the link out of the report is visibly a link", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  await page.route("**/spaces/*/import", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      degraded: [], pagesCreated: 2, emptyPagesCreated: 0, attachmentsImported: 0,
      attachmentsSkipped: [], deadCrossLinks: 0, published: 0, lossyTitles: false,
    }),
  }));
  const spaceId = await page.evaluate(async (api) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const s = await (await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: `Imp Link ${Date.now()}` }) })).json() as { id: string };
    return s.id;
  }, API);

  await page.goto(`/spaces/${spaceId}/settings/import`);
  await page.getByTestId("space-import-input").setInputFiles({ name: "x.zip", mimeType: "application/zip", buffer: Buffer.from("PK\x03\x04rest") });
  await page.getByTestId("import-start").click();
  await expect(page.getByTestId("import-report")).toBeVisible({ timeout: 20000 });

  const look = await page.getByTestId("import-open-space").evaluate((el) => {
    const s = getComputedStyle(el);
    const body = getComputedStyle(document.body);
    return { colour: s.color, bodyColour: body.color, underline: s.textDecorationLine };
  });
  expect(look.underline, "underlined without waiting for a pointer").toContain("underline");
  expect(look.colour, "not the same colour as ordinary text").not.toBe(look.bodyColour);
});

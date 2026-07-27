import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// #505 / ADR-191: the app's print action renders the page server-side (export.html — every macro static,
// one canonical renderer), but the browser's own Ctrl+P used to fall to the print stylesheet over the
// client portal instead. Two roads to paper means two things to keep in parity, which is the drift this
// work keeps finding. The shortcut takes the same road now.
test("#505: Ctrl+P goes through the server-rendered export, not the client portal", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/export.html")) requested.push(r.url()); });
  // the print dialog would block the run — stub it out; what we pin is WHICH document gets printed
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => { (window as unknown as { __printed: number }).__printed += 1; };
  });

  // On a PUBLISHED page. The export is of the published version, so an unpublished page has no document
  // to print — see the second test, which pins that the shortcut falls back there instead of printing an
  // empty sheet. This one used to run on the demo page, which is not published: it passed because the
  // export answered 200 with a title-only document, i.e. it pinned the very emptiness that was the bug.
  const id = await openScratch(page, `printshortcut-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Printed\n\nbody text\n");
  await sleep(1000);
  await page.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId: id });
  await sleep(400);
  await page.keyboard.press("Control+p");
  await sleep(1500);

  expect(requested.length, "the shortcut fetched the server-rendered document").toBeGreaterThan(0);
  expect(requested[0], "…for the page in view").toContain("/export.html");
  // the app's own action uses the same door (sanity: the endpoint is reachable for this page)
  const status = await page.evaluate(async ({ api, pageId }) => {
    const r = await fetch(`${api}/pages/${pageId}/export.html`, { headers: { Authorization: "Bearer dev-token" } });
    return r.status;
  }, { api: API, pageId: id });
  expect(status).toBe(200);
});

// #85 review: the same shortcut on a page that was never published. The export document is of the
// PUBLISHED version, so there is nothing to fetch — and the app is supposed to fall back to printing the
// live surface. It did not: the export answered 200 with a document holding only the title, so Ctrl+P on
// a draft printed a blank sheet with a heading. The endpoint reports absence now, and the fallback runs.
test("#85/#505: Ctrl+P on an unpublished page falls back to printing the live surface", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => { (window as unknown as { __printed: number }).__printed += 1; };
  });
  const id = await openScratch(page, `printdraft-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Draft only\n\nnever published\n");
  await sleep(900);

  const status = await page.evaluate(async ({ api, pageId }) => {
    const r = await fetch(`${api}/pages/${pageId}/export.html`, { headers: { Authorization: "Bearer dev-token" } });
    return r.status;
  }, { api: API, pageId: id });
  expect(status, "an unpublished page has no export document").toBe(404);

  await page.keyboard.press("Control+p");
  await sleep(1200);
  const printed = await page.evaluate(() => (window as unknown as { __printed: number }).__printed);
  expect(printed, "the app printed the live surface instead of an empty document").toBeGreaterThan(0);
});

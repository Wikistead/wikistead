import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// #505 → #85 / ADR-194 (Option B): the shortcut and the menu print the SAME document, and since the ruling
// that document is built by this browser out of the surface it already drew — not fetched from the server.
// This spec used to assert the opposite (a request to /export.html), which was the contract before the
// ruling; re-aimed rather than deleted, because what it is really guarding is "one road to paper".
test("#85/#505: Ctrl+P prints the browser-built document, and asks the server for nothing", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/export.html")) requested.push(r.url()); });
  // The document is printed from an offscreen frame, so the frame's own srcdoc is what proves WHICH
  // document went to paper. It is read at assertion time rather than on insertion: the frame is appended
  // first and its srcdoc set after, so an observer watching insertions sees an empty one.
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
  // Reload so the app re-reads the published body it will print (the publish above went straight to the
  // API, which the client's cache has no reason to have noticed).
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(800);
  await page.keyboard.press("Control+p");
  await sleep(6000); // the body renders with LIVE macros and waits for them to settle before serializing

  const docs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map((f) => (f as HTMLIFrameElement).srcdoc || ""));
  expect(docs.filter(Boolean).length, "the shortcut built a document to print").toBeGreaterThan(0);
  const doc = docs.filter(Boolean).pop()!;
  expect(doc, "…and it is the export document, wearing the app's own markup").toContain("wks-export-doc");
  expect(doc, "…carrying the page's content").toContain("body text");
  expect(requested, "nothing was fetched from the server to print it").toEqual([]);
});

// #85 review: the same shortcut on a page that was never published. The export document is of the
// PUBLISHED version, so there is nothing to fetch — and the app is supposed to fall back to printing the
// live surface. It did not: the export answered 200 with a document holding only the title, so Ctrl+P on
// a draft printed a blank sheet with a heading. The endpoint reports absence now, and the fallback runs.
test("#85/#505: Ctrl+P on an UNPUBLISHED page prints the draft itself, not the application", async ({ page }) => {
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
  expect(status, "the server has no published version to export").toBe(404);

  // #85 / ADR-194: and yet the page prints, because a draft HAS a document — the browser builds it from
  // the surface in front of the author. Before this it fell back to printing the application chrome.
  await page.keyboard.press("Control+p");
  await sleep(7000);
  const docs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map((f) => (f as HTMLIFrameElement).srcdoc || "").filter(Boolean));
  expect(docs.length, "the draft produced a document of its own").toBeGreaterThan(0);
  expect(docs.pop()!, "…carrying what the author is looking at").toContain("never published");
});

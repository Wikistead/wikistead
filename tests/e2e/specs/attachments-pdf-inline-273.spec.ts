import { test, expect } from "@playwright/test";
import { openDemo, openScratch, enterEdit, sleep } from "../helpers";

const API = "http://dev.localhost:4010";

// #273 / ADR-120 (Option B,): a sniffed PDF attachment renders inline via OUR pdf.js inside an
// OPAQUE-ORIGIN iframe — `sandbox="allow-scripts"` (so pdf.js runs) but NO `allow-same-origin` (the frame
// can't reach the app origin / cookies / storage). That containment attribute is the security contract the
// review requires (once #274 lets anonymous editors drop attacker-controlled PDF bytes, the blast radius of a
// pdf.js parser bug must stay in the opaque frame), so it is attribute-asserted here. Real Chromium (the async
// attachment resolve → iframe mount is only observable in a browser). The server-side sniff (a non-PDF /
// HTML-disguised-as-PDF → inline_kind "none" → no inline route) is covered by attachments-inline-273.test.ts.
// A VALID single-page PDF (proper xref table + a content stream drawing a filled rectangle), so pdf.js renders
// it to a real canvas AND the "Loading…" message hides on success — therendering pin (an earlier
// malformed PDF made page.render throw "Could not display", which masked whether the frame even loaded).
const MINIMAL_PDF = Buffer.from("JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PD4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDMwPj5zdHJlYW0KMCAwIDEgcmcgMjAgMjAgMTIwIDEyMCByZSBmCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDUKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTQgMDAwMDAgbiAKMDAwMDAwMDEwNSAwMDAwMCBuIAowMDAwMDAwMTk5IDAwMDAwIG4gCnRyYWlsZXI8PC9TaXplIDUvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgoyNzMKJSVFT0YK", "base64");

test("#273: a sniffed PDF renders in a sandboxed (allow-scripts, NO allow-same-origin) pdf.js frame", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  await enterEdit(page);

  // upload the PDF via the attachments panel (presign → PUT → confirm sniffs inline_kind = pdf).
  const name = `e2e-${Date.now().toString(36)}.pdf`;
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=attachments-toggle]");
  await expect(page.getByTestId("attachments-panel")).toBeVisible();
  await sleep(200);
  await page.setInputFiles("[data-testid=attachments-panel] input[type=file]", { name, mimeType: "application/pdf", buffer: MINIMAL_PDF });
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("[data-testid=attach-item]")].some((e) => (e as HTMLElement).innerText.includes(n)),
    name,
    { timeout: 8000 },
  );
  const pdfId = await page.evaluate(async ({ api, n }) => {
    const list = await (await fetch(`${api}/spaces/demo_space/pages/demo/attachments`, { headers: { Authorization: "Bearer dev-token" } })).json();
    return (list.find((a: { filename: string }) => a.filename === n) as { id: string }).id;
  }, { api: API, n: name });

  const linkName = `doc-${Date.now().toString(36)}.pdf`;
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(`\n[${linkName}](wks-attachment:${pdfId})\n`);
  await page.keyboard.press("ArrowUp"); // caret off the attachment line → it renders as the card atom
  await sleep(700);

  // the standalone PDF attachment mounts the inline viewer frame with the containment sandbox.
  const pdfCard = page.locator("[data-pane=preview] [data-testid=attachment-card]").filter({ hasText: linkName });
  const frame = pdfCard.locator("[data-testid=attachment-inline-frame]");
  await expect(frame).toHaveCount(1, { timeout: 8000 });
  const sandbox = await frame.getAttribute("sandbox");
  expect(sandbox).toBe("allow-scripts"); // our pdf.js runs…
  expect(sandbox).not.toContain("allow-same-origin"); // …but the frame is opaque-origin (can't reach the app)
  expect(await frame.getAttribute("src")).toContain("/pdf-frame.html");

  //(review bounce — the shipped test was false-green): assert the PDF actually RENDERS, not just
  // that the frame mounts. The opaque frame's module script + blob worker must load (ACAO + blob-worker fix),
  // then pdf.js paints the page to a <canvas> and the "Loading…" message disappears.
  const pdfFrame = page.frameLocator("[data-testid=attachment-inline-frame]");
  await expect(pdfFrame.locator("canvas")).toHaveCount(1, { timeout: 20000 });
  await expect(pdfFrame.locator("#msg")).toBeHidden();

  // #273(SUPERSEDES theall-open pin): affordances split by REGION — the HEADER means
  // DOWNLOAD (pointer cursor, click fires a download, never the lightbox); the PREVIEW area owns
  // "open" (zoom-in + lightbox, pinned by thetest below).
  const pdfCursor = await pdfCard.locator(".cm-lp-attachment-card").evaluate((el) => getComputedStyle(el).cursor);
  expect(pdfCursor).toBe("pointer");
  const dl = page.waitForEvent("download", { timeout: 10000 });
  await pdfCard.locator(".cm-lp-attachment-name").click();
  await dl;
  await expect(page.getByTestId("attachment-lightbox"), "header click never opens the lightbox").toHaveCount(0);
});

// #273 c 07-16 return (2): the INLINE CHIP is pressable — hover wash + cursor on both surfaces; on the
// READ-ONLY surface a body click runs the type's primary action (non-PDF → download). The edit surface
// keeps the caret/raw-reveal pass-through (only cursor/hover change there).
test("#273 affordance: the inline chip shows hover/cursor, and read-mode click downloads (non-PDF)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await openScratch(page, "chip-affordance-273");
  await enterEdit(page);
  const name = `e2e-chip-${Date.now().toString(36)}.bin`;
  const binId = await uploadAttachment(page, pageId, name, "application/octet-stream", Buffer.from("binarybytes"));
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(`some text [${name}](wks-attachment:${binId}) more\n`);
  await sleep(600);
  const chip = page.getByTestId("attachment-chip").first();
  await expect(chip).toBeVisible();
  expect(await chip.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  // publish → read surface → chip click downloads
  await page.getByTestId("publish-page").click();
  await sleep(800);
  const dl = page.waitForEvent("download", { timeout: 10000 });
  await page.getByTestId("attachment-chip").first().click();
  await dl;
});

// #273clicking a PDF card's body opens it LARGE in an in-app lightbox that reuses the SAME containment
// (opaque sandbox="allow-scripts", NO allow-same-origin, /pdf-frame.html). Escape closes it. Real Chromium.
test("#273the PDF card opens a lightbox with the same containment; Escape closes it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await openScratch(page, "pdf-lightbox-273"); // isolated page (no shared-demo card accumulation)
  await enterEdit(page);
  const name = `e2e-lb-${Date.now().toString(36)}.pdf`;
  const pdfId = await uploadAttachment(page, pageId, name, "application/pdf", MINIMAL_PDF);

  const linkName = `lb-${Date.now().toString(36)}.pdf`;
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(`\n[${linkName}](wks-attachment:${pdfId})\n`);
  await page.keyboard.press("ArrowUp");
  await sleep(700);

  const pdfCard = page.locator("[data-pane=preview] [data-testid=attachment-card]").filter({ hasText: linkName });
  await expect(pdfCard.locator("[data-testid=attachment-inline-frame]")).toHaveCount(1, { timeout: 8000 });

  // the hover overlay marks the "open large" affordance (cursor:zoom-in) and captures the expand click.
  const expand = pdfCard.locator("[data-testid=attachment-expand]");
  await pdfCard.hover();
  // the overlay flips to pointer-events:auto + cursor:zoom-in on wrap:hover (the visible affordance)…
  const hovered = await expand.evaluate((el) => ({ cursor: getComputedStyle(el).cursor, pe: getComputedStyle(el).pointerEvents }));
  expect(hovered.cursor).toBe("zoom-in");
  expect(hovered.pe).toBe("auto");
  // …and clicking it opens the lightbox (dispatch the click directly — Playwright's actionability races the
  // pointer-events transition, but the affordance is proven above).
  await expand.evaluate((el) => (el as HTMLElement).click());

  // the lightbox opens with the SAME containment sandbox (allow-scripts, NOT allow-same-origin) and renders.
  const lb = page.locator("[data-testid=attachment-lightbox]");
  await expect(lb).toHaveCount(1, { timeout: 8000 });
  const lbFrame = lb.locator("[data-testid=attachment-lightbox-frame]");
  const sandbox = await lbFrame.getAttribute("sandbox");
  expect(sandbox).toBe("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");
  expect(await lbFrame.getAttribute("src")).toContain("/pdf-frame.html");
  await expect(page.frameLocator("[data-testid=attachment-lightbox-frame]").locator("canvas")).toHaveCount(1, { timeout: 20000 });

  // Escape closes it.
  await page.keyboard.press("Escape");
  await expect(lb).toHaveCount(0, { timeout: 4000 });
});

// Upload an attachment to `pageId` via the panel and return its id. mimeType drives the server sniff (a real
// PDF → inline; octet-stream / non-PDF bytes → inline_kind "none" → a download card).
async function uploadAttachment(page: import("@playwright/test").Page, pageId: string, name: string, mimeType: string, buffer: Buffer): Promise<string> {
  if ((await page.getByTestId("attachments-panel").count()) === 0) {
    await page.click("[data-testid=page-overflow-trigger]");
    await page.click("[data-testid=attachments-toggle]");
    await expect(page.getByTestId("attachments-panel")).toBeVisible();
    await sleep(150);
  }
  await page.setInputFiles("[data-testid=attachments-panel] input[type=file]", { name, mimeType, buffer });
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("[data-testid=attach-item]")].some((e) => (e as HTMLElement).innerText.includes(n)),
    name,
    { timeout: 8000 },
  );
  return page.evaluate(async ({ api, id, n }) => {
    const list = await (await fetch(`${api}/spaces/demo_space/pages/${id}/attachments`, { headers: { Authorization: "Bearer dev-token" } })).json();
    return (list.find((a: { filename: string }) => a.filename === n) as { id: string }).id;
  }, { api: API, id: pageId, n: name });
}

// #273(1): the PDF inline frame must appear RIGHT AFTER publish, without a reload. Root cause: the
// widget REVOKED the resolver's cached inline blob URL, so the second render (publish→view) got a dead cached
// URL and never re-mounted the frame. A FRESH scratch page (isolated from the shared demo page). Real Chromium.
test("#273the PDF inline frame re-mounts after publish without a reload", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await openScratch(page, "pdf-publish-273");
  await enterEdit(page);
  const name = `pub-${Date.now().toString(36)}.pdf`;
  const pdfId = await uploadAttachment(page, pageId, name, "application/pdf", MINIMAL_PDF);

  const linkName = `pub-doc-${Date.now().toString(36)}.pdf`;
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(`\n[${linkName}](wks-attachment:${pdfId})\n`);
  await page.keyboard.press("ArrowUp");
  await sleep(700);
  // the frame is present while editing.
  await expect(page.locator("[data-testid=attachment-inline-frame]")).toHaveCount(1, { timeout: 8000 });

  // publish through the UI (the transition that used to drop the frame). Publish is async (collab flush →
  // mutate → setEditing(false)); wait for the switch to VIEW mode (the Edit button appears) so we assert the
  // POST-transition state, then require the frame WITHOUT a reload.
  await page.click("[data-testid=publish-page]");
  await expect(page.getByTestId("edit-toggle")).toBeVisible({ timeout: 15000 }); // publish done → view mode
  // the published body renders the card (card=1 post-transition), and — the fix — its frame MOUNTS
  // without a reload (frame was 0 until reload).
  await expect(page.locator("[data-testid=attachment-card]")).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator("[data-testid=attachment-inline-frame]")).toHaveCount(1, { timeout: 10000 });
});

// #273(2): a DOWNLOAD card (non-inline binary) downloads on a click ANYWHERE in the card body, not just
// the ⤓ icon. An inline PDF card is excluded (its body is the viewer). Real Chromium (a real download event).
test("#273a download card downloads on a full-body click", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await openScratch(page, "dl-card-273");
  await enterEdit(page);
  const binName = `blob-${Date.now().toString(36)}.bin`;
  const binId = await uploadAttachment(page, pageId, binName, "application/octet-stream", Buffer.from("not a pdf, just bytes"));

  const linkName = `download-${Date.now().toString(36)}.bin`;
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(`\n[${linkName}](wks-attachment:${binId})\n`);
  await page.keyboard.press("ArrowUp");
  await sleep(600);

  const card = page.locator("[data-pane=preview] [data-testid=attachment-card]").filter({ hasText: linkName });
  await expect(card).toBeVisible();
  await expect(card.locator("[data-testid=attachment-inline-frame]")).toHaveCount(0); // a download card, no viewer

  // #273the full-surface-clickable download card must LOOK clickable — pointer cursor on the card
  // body and a visibly stronger background wash on hover (light/dark both come from currentColor color-mix).
  const cardBody = card.locator(".cm-lp-attachment-card");
  expect(await cardBody.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  const restingBg = await cardBody.evaluate((el) => getComputedStyle(el).backgroundColor);
  await cardBody.hover();
  const hoverBg = await cardBody.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(hoverBg).not.toBe(restingBg);

  // clicking the card BODY (the name label, not the ⤓ button) triggers the download.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 8000 }),
    card.locator(".cm-lp-attachment-name").click(),
  ]);
  expect(download.suggestedFilename()).toBeTruthy();
});

// #273(user ruling): an INLINE chip has no rendered preview, so a PDF chip must NOT zoom — the
// chip is pointer-cursored and a read-mode click DOWNLOADS (like every other chip); the lightbox stays
// exclusive to the standalone card's actually-rendered preview (the/⤢ pins above).
test("#273a PDF inline chip is pointer + download — never the lightbox", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await openScratch(page, "chip-pdf-dl-273");
  await enterEdit(page);
  const name = `e2e-chip-${Date.now().toString(36)}.pdf`;
  const pdfId = await uploadAttachment(page, pageId, name, "application/pdf", MINIMAL_PDF);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(`ref inline [${name}](wks-attachment:${pdfId}) here\n`);
  await sleep(800); // let the meta sniff resolve (the old bug keyed the zoom behaviour off it)
  const chip = page.getByTestId("attachment-chip").first();
  await expect(chip).toBeVisible();
  expect(await chip.evaluate((el) => getComputedStyle(el).cursor), "pointer, not zoom-in").toBe("pointer");
  await page.getByTestId("publish-page").click();
  await sleep(800);
  await sleep(400); // read surface + meta settle
  const dl = page.waitForEvent("download", { timeout: 10000 });
  await page.getByTestId("attachment-chip").first().click();
  await dl;
  await expect(page.getByTestId("attachment-lightbox"), "the chip never opens the lightbox").toHaveCount(0);
});

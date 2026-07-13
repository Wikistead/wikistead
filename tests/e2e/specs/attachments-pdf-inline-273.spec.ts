import { test, expect } from "@playwright/test";
import { openDemo, enterEdit, sleep } from "../helpers";

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
});

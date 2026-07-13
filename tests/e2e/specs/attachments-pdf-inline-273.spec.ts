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
const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

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
});

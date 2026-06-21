import { test, expect } from "@playwright/test";
import { openDemo, enterEdit, sleep } from "../helpers";

// P3: a ![alt](wks-attachment:<id>) reference renders as an <img> resolved to a
// fresh presigned URL. The load-bearing checks are non-persistence (the canonical
// Y.Text holds only the id — never the presigned URL, so no expiry breakage and no
// bearer in CRDT history) and that resolution goes through the FGA-checked download
// endpoint. The image is uploaded via the (proven) attachments panel path.
const API = "http://dev.localhost:4010";
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("wks-attachment image renders as <img>; the doc holds only the id", async ({ page }) => {
  await openDemo(page);

  // Isolated page under demo_space (FGA edit via inheritance) so this test's image
  // markdown doesn't pollute the shared demo doc.
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "P3 image page" }),
    });
    return (await r.json()).id as string;
  }, API);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);

  // Upload an image through the attachments panel (the proven presign→PUT→confirm path).
  await page.click("[data-testid=attachments-panel] [aria-expanded]");
  await sleep(300);
  await page.setInputFiles("[data-testid=attachments-panel] input[type=file]", {
    name: "pic.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1x1, "base64"),
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-testid=attach-item]")].some((e) => (e as HTMLElement).innerText.includes("pic.png")),
    undefined,
    { timeout: 8000 },
  );
  const attachmentId = await page.evaluate(async ({ api, pageId }) => {
    const list = await (await fetch(`${api}/spaces/demo_space/pages/${pageId}/attachments`, { headers: { Authorization: "Bearer dev-token" } })).json();
    return (list.find((a: { filename: string }) => a.filename === "pic.png") as { id: string }).id;
  }, { api: API, pageId });

  // Type the attachment reference into the page, then move the cursor off its line.
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type(`![pic](wks-attachment:${attachmentId})`);
  await page.keyboard.press("Enter");
  await page.keyboard.type("below the image");
  await sleep(500);

  // (1) renders as an <img> that actually loads (presigned URL serves the bytes)
  const img = page.locator("[data-pane=preview] img.cm-lp-image");
  await expect(img).toBeVisible();
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 6000 })
    .toBeGreaterThan(0);

  // (2) the resolved src is a presigned URL, NOT the wks-attachment ref
  const src = (await img.getAttribute("src")) ?? "";
  expect(src).toMatch(/^https?:\/\//);
  expect(src).not.toContain("wks-attachment");

  // (3) reveal-on-cursor: moving the cursor onto the image line (Ctrl+Home → doc
  // start, where the image is) replaces the <img> widget with editable raw markdown.
  // (Keyboard, not a click — the 1x1 test image is too small to click reliably.)
  await page.locator("[data-pane=preview] .cm-content").focus();
  await page.keyboard.press("Control+Home");
  await sleep(300);
  expect(await page.locator("[data-pane=preview] img.cm-lp-image").count()).toBe(0);

  // (4) NON-PERSISTENCE: the revealed raw shows the canonical Y.Text holds only the
  // id — never the presigned URL (no expiry breakage, no bearer in CRDT history).
  const raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw).toContain(`wks-attachment:${attachmentId}`);
  expect(raw).not.toContain(src.split("?")[0]!);
});

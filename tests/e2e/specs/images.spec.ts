import { test, expect } from "@playwright/test";
import { openDemo, enterEdit, sleep, API } from "../helpers";

// P3: a ![alt](wks-attachment:<id>) reference renders as an <img> resolved to a
// fresh presigned URL. The load-bearing checks are non-persistence (the canonical
// Y.Text holds only the id — never the presigned URL, so no expiry breakage and no
// bearer in CRDT history) and that resolution goes through the FGA-checked download
// endpoint. The image is uploaded via the (proven) attachments panel path.
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
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=attachments-toggle]");
  await page.waitForSelector("[data-testid=attachments-panel]");
  await sleep(200);
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

  // (3) #255: a standalone image is an ATOM — moving the cursor onto its line (Ctrl+Home) SELECTS it
  // (ring), it does NOT reveal raw. Raw markdown is reached only via explicit entry (Ctrl+Enter).
  await page.locator("[data-pane=preview] .cm-content").focus();
  await page.keyboard.press("Control+Home");
  await sleep(300);
  expect(await page.locator("[data-pane=preview] img.cm-lp-image").count(), "caret-on-line selects, not reveals").toBe(1);
  await expect(page.locator("[data-pane=preview] .cm-lp-image-wrap.cm-lp-atom-sel")).toHaveCount(1);
  // Ctrl+Enter → NOW reveal the raw markdown.
  await page.keyboard.press("Control+Enter");
  await sleep(300);
  expect(await page.locator("[data-pane=preview] img.cm-lp-image").count()).toBe(0);

  // (4) NON-PERSISTENCE: the revealed raw shows the canonical Y.Text holds only the
  // id — never the presigned URL (no expiry breakage, no bearer in CRDT history).
  const raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw).toContain(`wks-attachment:${attachmentId}`);
  expect(raw).not.toContain(src.split("?")[0]!);
});

test("the / image command uploads and inserts a wks-attachment reference", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "P3 image insert" }),
    });
    return (await r.json()).id as string;
  }, API);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content"); // caret in the (empty) doc

  // Image is layer P (insert) and now lives in the `/` palette, NOT the selection bubble.
  // Selecting it removes the "/image" token and opens the host file picker; choosing a
  // file uploads + inserts ![alt](wks-attachment:<id>) at the caret. Handle the native
  // file chooser the picker opens (Playwright intercepts input.click()).
  page.once("filechooser", (fc) =>
    fc.setFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from(PNG_1x1, "base64") }),
  );
  await page.keyboard.type("/image");
  await expect(page.getByTestId("slash-item-image")).toBeVisible();
  await page.keyboard.press("Enter");

  // #255: the inserted standalone image renders as an ATOM (raw hidden). It loads from the attachment…
  const img = page.locator("[data-pane=preview] img.cm-lp-image");
  await expect(img).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 6000 })
    .toBeGreaterThan(0);
  // …and revealing its raw (Ctrl+Home selects it, Ctrl+Enter reveals) shows the wks-attachment ref with the
  // filename as alt text.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Enter");
  await expect
    .poll(async () => page.locator("[data-pane=preview] .cm-content").innerText(), { timeout: 6000 })
    .toMatch(/!\[shot\.png\]\(wks-attachment:/);
});

test("drag-and-drop an image file onto the editor uploads and inserts it", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "P3 image drop" }),
    });
    return (await r.json()).id as string;
  }, API);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content"); // caret in the (empty) doc

  // Build a DataTransfer carrying an image File and dispatch a real drop on the
  // editor — the drop handler uploads (presign → PUT → confirm) then inserts the
  // ![alt](wks-attachment:<id>) reference.
  const dt = await page.evaluateHandle((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    return dataTransfer;
  }, PNG_1x1);
  await page.dispatchEvent("[data-pane=preview] .cm-content", "dragover", { dataTransfer: dt });
  await page.dispatchEvent("[data-pane=preview] .cm-content", "drop", { dataTransfer: dt });

  // #255: the reference is inserted and renders as a standalone image ATOM that loads…
  const img = page.locator("[data-pane=preview] img.cm-lp-image");
  await expect(img).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 6000 })
    .toBeGreaterThan(0);
  // …and revealing its raw (Ctrl+Home selects, Ctrl+Enter reveals) shows the wks-attachment ref.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Enter");
  await expect
    .poll(async () => page.locator("[data-pane=preview] .cm-content").innerText(), { timeout: 6000 })
    .toMatch(/!\[dropped\.png\]\(wks-attachment:/);
});

// 2e-1 regression guard: in the DEFAULT read-only view mode, reveal-on-cursor is
// inert — so a FIRST-LINE image (the view's default selection sits at position 0)
// still renders as an <img> instead of leaking raw markdown. The earlier P3 image
// tests only ever asserted in EDIT mode with the caret moved off the image line,
// so this view-mode + line-1 case was the blind spot that shipped the bug.
test("view mode renders a first-line image (reveal-on-cursor is off when read-only)", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "P3 image view-mode line1" }),
    });
    return (await r.json()).id as string;
  }, API);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);

  // upload an image via the proven attachments path
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=attachments-toggle]");
  await page.waitForSelector("[data-testid=attachments-panel]");
  await sleep(200);
  await page.setInputFiles("[data-testid=attachments-panel] input[type=file]", {
    name: "hero.png", mimeType: "image/png", buffer: Buffer.from(PNG_1x1, "base64"),
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-testid=attach-item]")].some((e) => (e as HTMLElement).innerText.includes("hero.png")),
    undefined, { timeout: 8000 });
  const id = await page.evaluate(async ({ api, pageId }) => {
    const list = await (await fetch(`${api}/spaces/demo_space/pages/${pageId}/attachments`, { headers: { Authorization: "Bearer dev-token" } })).json();
    return (list.find((a: { filename: string }) => a.filename === "hero.png") as { id: string }).id;
  }, { api: API, pageId });

  // author the image on LINE 1 (a leading hero image — the common KB layout)
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type(`![hero](wks-attachment:${id})`);
  await page.keyboard.press("Enter");
  await page.keyboard.type("caption below");
  await sleep(2800); // let the draft persist (collab debounce) before publishing

  // PUBLISH so the view renders it (draft/publish model: view shows the published
  // snapshot). Then reload fresh into view (no prior caret).
  await page.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId });
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(600);

  // the first-line image renders as an <img>; the raw ref is NOT shown
  const img = page.locator("[data-pane=preview] img.cm-lp-image");
  await expect(img).toBeVisible();
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("wks-attachment:");
});

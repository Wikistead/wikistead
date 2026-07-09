import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #255 comment 1073/1077: a standalone image is a first-class ATOM (select, don't reveal; hover buttons;
// alignment), and the excalidraw button row (✎ + Ctrl+↵ hint + align) must not overlap. Real Chromium.
// A made-up wks-attachment id is fine — the <img> won't load, but the atom wrap / btnRow / align classes
// render regardless (this test is about interaction + layout, not the bytes).

test("#255: a standalone image is an atom — click selects (no reveal), hover shows aligned buttons", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await openScratch(page, "img-atom");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n![alt](wks-attachment:fake-id)\nbot\n");
  await sleep(400);

  const wrap = page.locator("[data-pane=preview] .cm-lp-image-wrap").first();
  await expect(page.getByTestId("macro-image").first()).toBeVisible();
  await expect(wrap).toHaveClass(/cm-lp-align-center/); // centered by default

  // (1) a click SELECTS the atom (ring), it does NOT reveal raw.
  await page.getByTestId("macro-image").first().click();
  await sleep(150);
  await expect(page.locator("[data-pane=preview] .cm-lp-image-wrap.cm-lp-atom-sel")).toHaveCount(1);
  await expect(page.getByTestId("macro-image").first()).toBeVisible(); // still rendered (not raw)
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("wks-attachment");

  // (2) hover shows the btnRow (✎ reveal pill + align toggle), and they do NOT overlap.
  await wrap.hover();
  await sleep(120);
  const edit = wrap.getByTestId("macro-edit").first();
  const align = wrap.getByTestId("macro-align").first();
  const eb = (await edit.boundingBox())!;
  const ab = (await align.boundingBox())!;
  expect(ab.x, "align is fully right of the ✎ (no overlap)").toBeGreaterThanOrEqual(eb.x + eb.width - 1);

  // (3) #255 the segmented control picks a side directly (left button → align-left); display-only
  // wrap class + source `?align=`.
  await wrap.getByTestId("macro-align-left").click({ force: true });
  await sleep(200);
  await expect(page.locator("[data-pane=preview] .cm-lp-image-wrap")).toHaveClass(/cm-lp-align-left/);
  // reveal to confirm the source persisted the alignment on the opaque URL.
  await page.getByTestId("macro-image").first().click();
  await page.keyboard.press("Control+Enter");
  await sleep(200);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("wks-attachment:fake-id?align=left");
});

test("#255: right-click a standalone image offers alignment; an inline image is NOT an atom", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "img-ctx");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // line 1 = standalone image; line 2 = text WITH an inline image (not an atom)
  await page.keyboard.insertText("![a](wks-attachment:fake-id)\nsee ![b](wks-attachment:fake-id) here\nbot\n");
  await sleep(400);

  // exactly ONE atom wrap (the standalone one); the inline image is a plain widget, not a wrap.
  await expect(page.locator("[data-pane=preview] .cm-lp-image-wrap")).toHaveCount(1);

  // right-click the standalone image → the context menu offers alignment; choose left.
  await page.getByTestId("macro-image").first().click({ button: "right" });
  await expect(page.getByTestId("ctx-item-align-left")).toBeVisible();
  await page.getByTestId("ctx-item-align-left").click();
  await sleep(200);
  await expect(page.locator("[data-pane=preview] .cm-lp-image-wrap")).toHaveClass(/cm-lp-align-left/);
});

// #255 comment 1077: excalidraw's ✎ carries the Ctrl+↵ hint pill (it's a richEditUI macro), which widened
// it past the old magic-number offset. The flex btnRow keeps the align toggle fully to the ✎'s right — this
// pins it on a HINT-PILL macro (the earlier miss was testing only mermaid, which has no hint pill).
test("#255: excalidraw ✎ (with Ctrl+↵ hint) and the align toggle do not overlap", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  await openScratch(page, "excal-btnrow");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText('top\n```excalidraw\n{"type":"excalidraw","elements":[],"appState":{}}\n```\nbot\n');
  await sleep(1200);
  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap:has([data-testid=macro-excalidraw])").first();
  await page.getByTestId("macro-excalidraw").first().hover();
  await sleep(200);
  const edit = wrap.locator("> .cm-lp-macro-btnrow [data-testid=macro-edit]").first();
  const align = wrap.locator("> .cm-lp-macro-btnrow [data-testid=macro-align]").first();
  const eb = (await edit.boundingBox())!;
  const ab = (await align.boundingBox())!;
  // the ✎ (with hint) ends before the align begins — no overlap.
  expect(ab.x).toBeGreaterThanOrEqual(eb.x + eb.width - 1);
});

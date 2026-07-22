import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #488: while a file is dragged over the editor, show WHERE it will land. The drop already inserts
// at posAtCoords under the pointer (image-drop.ts), but nothing said so until the file was in the
// document — so the user aimed blind. The cursor is CodeMirror's own dropCursor, which draws at that
// same position, and the pin that matters is that the two agree: what is drawn is where it lands.

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function fileDrag(page: Page) {
  return page.evaluateHandle((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    return dataTransfer;
  }, PNG_1x1);
}

/** Where CodeMirror says a point maps to, and where it would draw the caret for it. */
const coordsFor = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => {
    const el = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as {
      posAtCoords(c: { x: number; y: number }): number | null;
      coordsAtPos(p: number): { left: number; top: number; bottom: number } | null;
      state: { doc: { lineAt(p: number): { number: number } } };
    };
    const pos = view.posAtCoords({ x: px, y: py });
    if (pos == null) return null;
    const c = view.coordsAtPos(pos);
    return { pos, line: view.state.doc.lineAt(pos).number, left: c?.left ?? null, top: c?.top ?? null };
  }, [x, y] as const);

test("#488: dragging a file over the editor shows the caret where it will land", async ({ page }) => {
  await openScratch(page, `drop488-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("first line\nsecond line\nthird line\nfourth line\n");
  await sleep(500);

  const dt = await fileDrag(page);
  const content = page.locator("[data-pane=preview] .cm-content");
  const cursor = page.locator("[data-pane=preview] .cm-dropCursor");
  await expect(cursor, "nothing is drawn before a drag starts").toHaveCount(0);

  // aim at the third line, a little way into it
  const third = page.getByText("third line", { exact: true });
  const box = (await third.boundingBox())!;
  const aim = { x: box.x + box.width * 0.5, y: box.y + box.height / 2 };
  await page.dispatchEvent("[data-pane=preview] .cm-content", "dragover", { dataTransfer: dt, clientX: aim.x, clientY: aim.y });
  await sleep(200);

  await expect(cursor, "the drop cursor appears while a file is over the editor").toHaveCount(1);
  const drawn = (await cursor.boundingBox())!;
  const target = (await coordsFor(page, aim.x, aim.y))!;
  expect(target.line, "the pointer really is over the third line").toBe(3);
  expect(Math.abs(drawn.x - target.left!), "drawn where the drop will insert (x)").toBeLessThan(2);
  expect(Math.abs(drawn.y - target.top!), "drawn where the drop will insert (y)").toBeLessThan(3);

  // and it follows the pointer to another line
  const first = page.getByText("first line", { exact: true });
  const fbox = (await first.boundingBox())!;
  const moved = { x: fbox.x + fbox.width * 0.5, y: fbox.y + fbox.height / 2 };
  await page.dispatchEvent("[data-pane=preview] .cm-content", "dragover", { dataTransfer: dt, clientX: moved.x, clientY: moved.y });
  await sleep(200);
  const after = (await cursor.boundingBox())!;
  expect(after.y, "the cursor moved up with the pointer").toBeLessThan(drawn.y - 2);
  const movedTarget = (await coordsFor(page, moved.x, moved.y))!;
  expect(movedTarget.line).toBe(1);
  expect(Math.abs(after.x - movedTarget.left!), "still where the drop would insert").toBeLessThan(2);
});

test("#488: the cursor is retracted once the file is dropped, and the file lands there", async ({ page }) => {
  await openScratch(page, `drop488b-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("alpha\nbravo\ncharlie\n");
  await sleep(500);

  const dt = await fileDrag(page);
  const cursor = page.locator("[data-pane=preview] .cm-dropCursor");
  const bravo = page.getByText("bravo", { exact: true });
  const box = (await bravo.boundingBox())!;
  const aim = { x: box.x + box.width, y: box.y + box.height / 2 };

  await page.dispatchEvent("[data-pane=preview] .cm-content", "dragover", { dataTransfer: dt, clientX: aim.x, clientY: aim.y });
  await sleep(200);
  await expect(cursor).toHaveCount(1);
  const aimed = (await coordsFor(page, aim.x, aim.y))!;

  await page.dispatchEvent("[data-pane=preview] .cm-content", "drop", { dataTransfer: dt, clientX: aim.x, clientY: aim.y });
  // The file drop is handled in capture phase and stops propagation, so CodeMirror never sees the
  // drop that would normally retract its cursor — if that is not compensated for, this hangs around.
  await expect(cursor, "the cursor goes away when the file is let go").toHaveCount(0, { timeout: 5000 });

  // and the upload lands at the line that was pointed at, not at the end of the document
  const readDoc = () => page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as
      { state: { doc: { toString(): string } } };
    return view.state.doc.toString();
  });
  await expect.poll(readDoc, { timeout: 20_000 }).toContain("wks-attachment:");
  const doc = await page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as
      { state: { doc: { toString(): string; lineAt(p: number): { number: number } } } };
    return view.state.doc.toString();
  });
  const refLine = doc.split("\n").findIndex((l) => l.includes("wks-attachment:")) + 1;
  expect(refLine, `inserted on the aimed line (doc: ${JSON.stringify(doc)})`).toBe(aimed.line);
});

// the drop cursor is an affordance for a drop. attachFileDrop is wired editable-only
// (editor-livepreview.ts), so on the Reading surface (mountLivePreview with readOnly) a file drag used
// to draw the cursor over a surface where nothing can drop. dropCursor is gated on !readOnly now, in
// lockstep with the handler — the affordance appears only where the drop can happen.
test("#488 Reading mode shows no drop cursor (nothing can be dropped there)", async ({ page }) => {
  await openScratch(page, `drop488ro-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("alpha line\nbeta line\ngamma line\n");
  await sleep(400);
  // sanity: the drop cursor DOES draw while editing (the existing behaviour we are keeping)
  const dt = await fileDrag(page);
  const gamma = page.getByText("gamma line", { exact: true });
  const gb = (await gamma.boundingBox())!;
  const aim = { x: gb.x + gb.width * 0.5, y: gb.y + gb.height / 2 };
  await page.dispatchEvent("[data-pane=preview] .cm-content", "dragover", { dataTransfer: dt, clientX: aim.x, clientY: aim.y });
  await sleep(200);
  await expect(page.locator("[data-pane=preview] .cm-dropCursor"), "the editable surface still shows it").toHaveCount(1);

  // switch to Reading (read-only): a file drag must draw NO cursor, because a drop would do nothing
  await page.getByTestId("displaymode-reading").click({ force: true });
  await sleep(500);
  const dt2 = await fileDrag(page);
  const g2 = (await page.getByText("gamma line", { exact: true }).boundingBox())!;
  const aim2 = { x: g2.x + g2.width * 0.5, y: g2.y + g2.height / 2 };
  await page.dispatchEvent("[data-pane=preview] .cm-content", "dragover", { dataTransfer: dt2, clientX: aim2.x, clientY: aim2.y });
  await sleep(300);
  await expect(page.locator("[data-pane=preview] .cm-dropCursor"), "Reading mode offers no drop affordance").toHaveCount(0);
});

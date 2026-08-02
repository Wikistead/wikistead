import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #577, the state my first attempt could not build. The review measured it and named the cause:
// the layout owner rejects a candidate that leaves `bounds`, and `bounds` was THIS view's own
// scroller. Inside a nested edit island the island's scroller starts at the block's top edge, so every
// upward candidate — and the inline ones, which keep dy = 0 — is "off screen", and the downward flip
// is the only survivor. Downward is onto the block's own drawing: 1111px² inside an excalidraw canvas,
// with NO other affordance on screen, which is why "the rows above are taken" was the wrong diagnosis
// and why my first fixture (a single editor) could not reproduce it.
//
// HONEST STATUS: this spec asserts the INVARIANT in a real browser, and it does not reproduce the
// reported state. Measured here: Ctrl+Enter on the nested excalidraw leaves both editors unfocused
// (`--aff-dy-row` 0px on each), so the owner never takes the island's scroller as its bounds and the
// pill sits above the drawing whether or not the fix is applied — it stays green with the fix
// removed. The regression pin for this ticket is choose-slot-577.test.ts, which feeds the device
// check's own numbers to the placement function directly; this one guards the rule end to end.
const SCENE = JSON.stringify({
  type: "excalidraw", version: 2,
  elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 120, height: 80, angle: 0,
    strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff", fillStyle: "solid", strokeWidth: 2,
    strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }],
  appState: {}, files: {},
});
const FIXTURE = [
  "intro line", "",
  "::::columns", ":::column", "```excalidraw", SCENE, "```", ":::",
  ":::column", "```mermaid", "graph TD; A-->B;", "```", ":::", "::::",
  "", "tail line", "",
].join("\n");

async function author(page: Page): Promise<void> {
  await openScratch(page, `np577b-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view to write the fixture into");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, FIXTURE);
  await sleep(2500); // excalidraw + mermaid draw async
}

/** Geometry of the visible chrome against the nested drawing, plus the editor count that proves we
 *  are in the island (one editor means the state under test was never entered). */
const measure = (page: Page) =>
  page.evaluate(() => {
    const visible = (e: Element) => {
      const c = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return c.display !== "none" && c.visibility !== "hidden" && parseFloat(c.opacity || "1") > 0.05 && r.height > 0 && r.width > 0;
    };
    const drawing = document.querySelector("[data-testid=macro-excalidraw] svg, [data-testid=macro-excalidraw] canvas, [data-testid=macro-excalidraw]") as HTMLElement | null;
    const dr = drawing?.getBoundingClientRect() ?? null;
    const chrome = [...document.querySelectorAll(".cm-lp-macro-btnrow, .cm-lp-macro-richui-raw, .cm-lp-nested-macro-edit")]
      .filter(visible)
      .map((e) => {
        const r = e.getBoundingClientRect();
        const over = dr ? Math.max(0, Math.min(r.right, dr.right) - Math.max(r.left, dr.left)) * Math.max(0, Math.min(r.bottom, dr.bottom) - Math.max(r.top, dr.top)) : 0;
        return { cls: (e.className as string).slice(0, 40), top: Math.round(r.top), left: Math.round(r.left), overlapPx2: Math.round(over) };
      });
    const editors = [...document.querySelectorAll(".cm-editor")].map((e) => ({
      focused: e.classList.contains("cm-focused"),
      dyRow: getComputedStyle(e).getPropertyValue("--aff-dy-row").trim(),
    }));
    return { editors, chrome, drawing: dr ? { top: Math.round(dr.top), bottom: Math.round(dr.bottom) } : null };
  });

test("#577: a pill inside a nested edit island does not land on the block's drawing", async ({ page }) => {
  await author(page);

  // select the nested excalidraw, then ENTER its island (Ctrl+Enter) — this is the state the report
  // was made in, and the one a single-editor fixture cannot produce
  const drawing = page.locator("[data-testid=macro-excalidraw]").first();
  await drawing.click({ position: { x: 12, y: 12 } });
  await sleep(400);
  await page.keyboard.press("Control+Enter");
  await sleep(900);

  const m = await measure(page);
  // the fixture is only meaningful in the island: prove we are there before asserting anything
  expect(m.editors.length, `two editors means the island is open (got ${JSON.stringify(m.editors)})`).toBeGreaterThan(1);
  expect(m.drawing, "the drawing must be on screen to be overlapped").not.toBeNull();

  const onTheDrawing = m.chrome.filter((c) => c.overlapPx2 > 0);
  expect(onTheDrawing, `chrome must not sit on the drawing: ${JSON.stringify(m.chrome)}`).toEqual([]);
});

test("#577: the island's chrome is still on screen (not hidden to avoid the drawing)", async ({ page }) => {
  await author(page);
  const drawing = page.locator("[data-testid=macro-excalidraw]").first();
  await drawing.click({ position: { x: 12, y: 12 } });
  await sleep(400);
  await page.keyboard.press("Control+Enter");
  await sleep(900);

  // #456's ruling: "does not overlap" must never be bought with "is not visible". Whatever the owner
  // chose, the chrome is inside the OUTER scroller — which is the surface it is drawn on.
  const ok = await page.evaluate(() => {
    const outer = [...document.querySelectorAll(".cm-scroller")][0] as HTMLElement;
    const b = outer.getBoundingClientRect();
    const chrome = [...document.querySelectorAll(".cm-lp-macro-btnrow, .cm-lp-macro-richui-raw")]
      .filter((e) => {
        const c = getComputedStyle(e);
        return c.display !== "none" && parseFloat(c.opacity || "1") > 0.05 && e.getBoundingClientRect().height > 0;
      })
      .map((e) => e.getBoundingClientRect());
    return chrome.map((r) => ({ inside: r.top >= b.top - 1 && r.bottom <= b.bottom + 1, top: Math.round(r.top) }));
  });
  expect(ok.length, "there is chrome to check").toBeGreaterThan(0);
  expect(ok.every((c) => c.inside), `all chrome stays on the visible surface: ${JSON.stringify(ok)}`).toBe(true);
});

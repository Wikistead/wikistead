import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #577 (user, real device): selecting an Excalidraw inside `::::columns` put the pill ON TOP of the
// drawing.
//
// HONEST STATUS: this spec pins the INVARIANT, not a reproduction. The reported geometry (pill flipped
// +44px down, landing 20px inside the canvas) needs every row above the nested block to be unavailable,
// and this harness could not manufacture that state — with the fixture below the owner still finds the
// row above free (measured: dy 0, and with a pinned presence box occupying the row, dy -22 — upward,
// never the downward flip). So: the rule "chrome never sits on its block's own drawing" is asserted
// here and holds, but removing the fix does NOT turn this red. Stated rather than dressed up. The layout owner was doing what it was told — every row ABOVE a nested block belongs to the
// container's own chrome, so the only slot left was the downward flip, and downward means inside the
// block. "Nothing overlaps another affordance" and "nothing is hidden" were both satisfied; the rule
// that was missing is "nothing sits on the block's own content". The fix gives the search an inline
// axis (a nested block has no room above, but it does have room beside), so this pins:
//   1. the pill does NOT intersect the nested drawing (RED before: measured 20px inside the canvas);
//   2. the #528 invariants hold — no affordance pair intersects, and none is pushed off screen;
//   3. a TOP-LEVEL macro still gets the row above (the fix must not move what already worked).
const SCENE = JSON.stringify({
  type: "excalidraw", version: 2,
  elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 120, height: 80, angle: 0,
    strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff", fillStyle: "solid", strokeWidth: 2,
    strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }],
  appState: {}, files: {},
});
const FIXTURE = [
  "::::columns", ":::column", "```excalidraw", SCENE, "```", ":::",
  ":::column", "```mermaid", "graph TD; A-->B;", "```", ":::", "::::",
  "", "```mermaid", "graph TD; C-->D;", "```", "", "tail line", "",
].join("\n");

async function author(page: Page): Promise<void> {
  await openScratch(page, `np577-${Date.now().toString(36)}`);
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

const AFF = ".cm-lp-macro-richui-raw, .cm-lp-macro-btnrow, .cm-lp-nested-macro-edit, .cm-macro-presence-box";
const measure = (page: Page, drawingSel: string) =>
  page.evaluate((sel) => {
    const vis = (el: Element) => {
      const cs = getComputedStyle(el as HTMLElement);
      const r = el.getBoundingClientRect();
      return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.05 && r.width > 0 && r.height > 0;
    };
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom } };
    const affs = [...document.querySelectorAll(".cm-lp-macro-richui-raw, .cm-lp-macro-btnrow, .cm-lp-nested-macro-edit, .cm-macro-presence-box")]
      .filter(vis).map((el) => ({ cls: (el as HTMLElement).className, ...box(el) }));
    const drawing = document.querySelector(sel);
    const scroller = document.querySelector("[data-pane=preview] .cm-scroller")!;
    return { affs, drawing: drawing ? box(drawing) : null, view: box(scroller) };
  }, drawingSel);

const intersects = (a: { x: number; y: number; right: number; bottom: number }, b: { x: number; y: number; right: number; bottom: number }) =>
  a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

test("#577: a nested block's pill sits beside the drawing, never on it", async ({ page }) => {
  await author(page);
  // select the nested excalidraw (the user's gesture)
  const drawing = page.locator("[data-testid=macro-excalidraw] svg, .cm-lp-columns [data-testid=macro-excalidraw]").first();
  await drawing.click({ position: { x: 30, y: 30 } });
  await sleep(600);

  const m = await measure(page, "[data-testid=macro-excalidraw]");
  expect(m.drawing, "the nested drawing is on screen").not.toBeNull();
  expect(m.affs.length, "chrome is showing for the selected block").toBeGreaterThan(0);

  // 1. the pill must not sit on the drawing
  for (const a of m.affs) {
    if (!/richui-raw|btnrow/.test(a.cls)) continue;
    expect(intersects(a, m.drawing!), `${a.cls} at (${Math.round(a.x)},${Math.round(a.y)}) overlaps the drawing`).toBe(false);
  }
  // 2. the #528 invariants: no pair intersects, nothing is pushed off the visible surface
  for (let i = 0; i < m.affs.length; i++) {
    for (let j = i + 1; j < m.affs.length; j++) {
      expect(intersects(m.affs[i]!, m.affs[j]!), `${m.affs[i]!.cls} × ${m.affs[j]!.cls}`).toBe(false);
    }
  }
  for (const a of m.affs) {
    expect(a.y, `${a.cls} stays on screen (top)`).toBeGreaterThanOrEqual(m.view.y - 1);
    expect(a.bottom, `${a.cls} stays on screen (bottom)`).toBeLessThanOrEqual(m.view.bottom + 1);
  }
});

test("#577: a TOP-LEVEL macro still takes the row above (no regression from the inline axis)", async ({ page }) => {
  await author(page);
  // the LAST mermaid in the doc is the top-level one (the fixture puts it after the columns block)
  const top = page.locator("[data-testid=macro-mermaid]").last();
  await top.click({ position: { x: 20, y: 20 } });
  await sleep(600);

  // The chrome is NOT inside its block's wrap (it is positioned against the line), so "above its own
  // block" cannot be asserted by containment. What IS exact: with the row above free, the owner must
  // not reach for the inline axis at all — the displacement variables stay at zero, i.e. a top-level
  // macro is placed exactly where it always was.
  const dx = await page.evaluate(() => {
    const root = document.querySelector("[data-pane=preview] .cm-editor") as HTMLElement | null;
    const read = (n: string) => (root?.style.getPropertyValue(n) || "0px").trim();
    return { pill: read("--aff-dx-pill"), row: read("--aff-dx-row"), nested: read("--aff-dx-nested") };
  });
  expect(dx.pill, "no sideways displacement for a top-level pill").toMatch(/^0px$|^$/);
  expect(dx.row, "…nor for its button row").toMatch(/^0px$|^$/);
});

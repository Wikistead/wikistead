import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #528 (user screenshot, second time this ruling came back): clicking a nested Excalidraw inside
// `::::columns` showed TWO selection chromes at once — the inner ring + pill row AND the container's own
// ring + pill — and the pill sat across the (container's) ring line. the ruling is "the focused
// block is the nested one, and ONLY it shows chrome"; the missing half was the SELECTION chrome gate:
// the container's atom-sel ring/btnrow did not yield while the slot island held the focus. The #556
// exclusivity (slotEdit counts as nested-active) closes it; this spec pins the two measurements so
// the ruling cannot regress a third time:
//   1. nested atom selected → EXACTLY ONE visible chrome set, the innermost's; the container wears the
//      grey context class, never atom-sel.
//   2. the inner pill row sits at the block's top-left WITHOUT crossing the selection ring's line.
// Real browser; the RED was taken by reverting the #556 gate (container atom-sel + a second chrome row
// reappear — the screenshot state).

const SCENE = JSON.stringify({
  type: "excalidraw", version: 2,
  elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 120, height: 80, angle: 0,
    strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff", fillStyle: "solid", strokeWidth: 2,
    strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }],
  appState: {}, files: {},
});

const FIXTURE = [
  "::::columns",
  ":::column",
  "```excalidraw",
  SCENE,
  "```",
  ":::",
  ":::column",
  "```mermaid",
  "graph TD; A-->B;",
  "```",
  ":::",
  "::::",
  "",
  "tail line",
  "",
].join("\n");

async function author(page: Page): Promise<void> {
  await openScratch(page, `nc528-${Date.now().toString(36)}`);
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

type Chrome = { cls: string; x: number; y: number; w: number; h: number };
const readState = (page: Page) =>
  page.evaluate(() => {
    const container = document.querySelector("[data-pane=preview] .cm-lp-macro-wrap:has(.cm-lp-columns)") as HTMLElement | null;
    const visible = (e: Element) => {
      const c = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return c.display !== "none" && c.visibility !== "hidden" && parseFloat(c.opacity || "1") > 0.05 && r.height > 0 && r.width > 0;
    };
    const chrome: Chrome[] = [];
    for (const e of document.querySelectorAll(".cm-lp-macro-btnrow, .cm-lp-macro-richui-raw")) {
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect();
      chrome.push({ cls: e.className.slice(0, 50), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    }
    const rings = [...document.querySelectorAll(".cm-lp-atom-sel")].map((e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return {
      containerCls: container?.className ?? "",
      chrome,
      rings,
    };
  });

test("#528 a nested Excalidraw selection shows ONE chrome set — the container's yields", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await author(page);
  await page.locator("[data-pane=preview] [data-testid=macro-excalidraw]").first().click();
  await sleep(800);
  const s = await readState(page);

  // the container is context, never a second selection (RED with the #556 gate reverted: atom-sel stayed)
  expect(s.containerCls, "the container drops to the grey context highlight").toContain("cm-lp-nested-host");
  expect(s.containerCls, "…and never wears the selection ring itself").not.toContain("cm-lp-atom-sel");

  // exactly one ring (the inner block's) and every visible chrome row belongs to it (top-left aligned)
  expect(s.rings.length, "exactly one selection ring anywhere").toBe(1);
  const ring = s.rings[0]!;
  expect(s.chrome.length, `one visible chrome row (got ${JSON.stringify(s.chrome)})`).toBe(1);
  const pill = s.chrome[0]!;
  expect(Math.abs(pill.x - ring.x), "the pill row sits at the block's LEFT edge").toBeLessThan(30);
  expect(pill.y, "…above its top").toBeLessThan(ring.y);

  // §2: the pill row must not cross the selection ring's line (outline sits ~2px outside the box)
  expect(pill.y + pill.h, "the pill row clears the ring line").toBeLessThanOrEqual(ring.y - 2);
});

test("#528 the same exclusivity holds for a nested mermaid (the reveal-type atom)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await author(page);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").first().click();
  await sleep(800);
  const s = await readState(page);
  // mermaid's own response is the #243 caret-in reveal — chrome may be its raw pill — but the container
  // must still yield: no second ring, no container button row.
  expect(s.containerCls).toContain("cm-lp-nested-host");
  expect(s.containerCls).not.toContain("cm-lp-atom-sel");
  expect(s.rings.length, "no stray selection ring appears").toBeLessThanOrEqual(1);
  expect(s.chrome.length, `at most one visible chrome row (got ${JSON.stringify(s.chrome)})`).toBeLessThanOrEqual(1);
});

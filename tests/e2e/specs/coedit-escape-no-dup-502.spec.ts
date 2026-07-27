import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #502 review rejection (2026-07-27): editing a mermaid source island during a co-edit and pressing Escape
// DUPLICATED the whole fence (2 fences became 4, joined as ```…``````mermaid), both clients then re-parsed
// the broken source, and the body was lost. Measured causes, in the order they had to be peeled:
//   1. Escape committed TWICE — the exit path's commit-on-blur plus the co-edit flush.
//   2. A peer's whole-block replace COLLAPSES the other client's mapped range to a point, so their commit
//      became a pure insert at that point — a second copy of the block.
//   3. The whole-block replace also destroyed the peer's block, closing their open RichUI.
// The pins are on the DOCUMENT STRING, not the rendering: this class of bug looks fine until you read the
// source. A lone editor is unaffected (there is no peer, no flush, and the same minimal commit).
const DOC = "# t\n\n```mermaid\ngraph TD\n  A[start] --> B[end]\n```\n\nafter\n";

const docText = (p: Page) => p.evaluate(() => {
  const ed = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
  const view = (ed?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as
    { state: { doc: { toString(): string } } };
  return view.state.doc.toString();
});
const fences = (s: string) => (s.match(/```/g) || []).length;
const islandOpen = (p: Page) => p.evaluate(() => !!document.querySelector(".cm-lp-editui-wrap"));

async function enterFenceIsland(p: Page) {
  await p.click("[data-pane=preview] .cm-content");
  await p.keyboard.press("Control+Home");
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown");
  await sleep(200);
  await p.keyboard.press("Control+Enter");
  await sleep(900);
}

test("#502: Escaping a co-edited island commits once, without duplicating the block", async ({ browser }) => {
  const ctxA = await browser.newContext(); const a = await ctxA.newPage();
  const id = await openScratch(a, `dup502-${Date.now()}`);
  await enterEdit(a);
  await a.click("[data-pane=preview] .cm-content");
  await a.keyboard.insertText(DOC);
  await sleep(1000);

  const ctxB = await browser.newContext(); const b = await ctxB.newPage();
  await b.goto(`/p/${id}`); await b.waitForSelector("[data-pane=preview] .cm-content");
  await enterEdit(b); await sleep(800);

  expect(fences(await docText(a)), "one fence pair to begin with").toBe(2);

  await enterFenceIsland(a);
  await enterFenceIsland(b);
  expect(await islandOpen(a), "both clients are in the island").toBe(true);
  expect(await islandOpen(b)).toBe(true);

  // A types one character and leaves
  await a.keyboard.press("Control+End");
  await a.keyboard.type("X");
  await sleep(500);
  await a.keyboard.press("Escape");
  await sleep(1500);

  for (const [who, page] of [["A", a], ["B", b]] as const) {
    const doc = await docText(page);
    expect(fences(doc), `${who}: the block must not duplicate`).toBe(2);
    expect(doc, `${who}: the body survives, with the edit`).toContain("A[start] --> B[end]X");
    expect(doc, `${who}: no concatenated fences`).not.toContain("``````");
  }
  // the peer was not thrown out of their own editor by the commit
  expect(await islandOpen(b), "B's RichUI survives A's commit").toBe(true);

  await ctxA.close(); await ctxB.close();
});

import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #502 review rejection (2026-07-27): "when the other person leaves, my cursor jumps to the start". The
// co-edit lifecycle re-mounts the island's surface when occupancy changes — binding to the shared body
// when a peer arrives, and back to a local one when they go. That re-mount destroys the old CodeMirror
// and builds a new one, which opens at offset 0. The text was carried across; the caret was not. So the
// person still typing had their cursor thrown to the top of the island by something the OTHER client did.
//
// Measured through the island's own editor rather than through key presses: what is being pinned is where
// the caret SITS after the swap, and reading it directly is what tells the two cases apart (kept vs 0).

const BODY = "one two three four five six seven";
const DOC = `:::note\n${BODY}\n:::\n\nafter\n`;

// CodeMirror hangs its ContentView off the content element, and that view points back at the EditorView —
// the same route the other co-edit specs use for the outer editor, aimed at the island's own editor here.
const ISLAND_VIEW = `(() => {
  const el = document.querySelector(".cm-lp-editui-wrap .cm-content");
  return el ? (el.cmView && el.cmView.view) || (el.cmTile && el.cmTile.view) : null;
})()`;
const islandCaret = (p: Page) => p.evaluate(`(() => {
  const view = ${ISLAND_VIEW};
  return view ? view.state.selection.main.head : -1;
})()`) as Promise<number>;
const setIslandCaret = (p: Page, at: number) => p.evaluate(`(() => {
  const view = ${ISLAND_VIEW};
  if (!view) return false;
  view.focus();
  view.dispatch({ selection: { anchor: ${at}, head: ${at} } });
  return true;
})()`) as Promise<boolean>;

async function enterIsland(p: Page) {
  await p.click("[data-pane=preview] .cm-content");
  await p.keyboard.press("Control+Home");
  await sleep(200);
  await p.keyboard.press("Control+Enter");
  await sleep(900);
}

test("#502: a peer arriving or leaving does not move my caret in the island", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctxA = await browser.newContext(); const a = await ctxA.newPage();
  const id = await openScratch(a, `coedit502caret-${Date.now()}`);
  await enterEdit(a);
  await a.click("[data-pane=preview] .cm-content");
  await a.keyboard.insertText(DOC);
  await sleep(900);

  const ctxB = await browser.newContext(); const b = await ctxB.newPage();
  await b.goto(`/p/${id}`); await b.waitForSelector("[data-pane=preview] .cm-content");
  await enterEdit(b); await sleep(800);

  await enterIsland(a);
  expect(await islandCaret(a), "the island is open on A").toBeGreaterThanOrEqual(0);
  await setIslandCaret(a, 12);
  await sleep(200);

  await enterIsland(b);
  await sleep(1400);
  expect(await islandCaret(a), "A's caret survives the peer ARRIVING").toBe(12);

  await b.keyboard.press("Escape");
  await sleep(1800);
  expect(await islandCaret(a), "A's caret survives the peer LEAVING").toBe(12);

  await ctxA.close(); await ctxB.close();
});

// STILL FAILING, on purpose and in the open (measured 2026-07-28). When the peer EDITS before leaving, the
// flush writes a changed body to the outer document and the island is rebuilt — and the caret goes to 0.
// That rebuild does not come through `updateDOM`/`mountInto`, where the fix in decorations.ts captures and
// restores the caret (which covers the swap and the in-place re-mount): the widget is replaced outright, so
// at that moment there is no surface left to read a caret from. Measured either side of the transition: 14
// while co-editing, 0 after the peer leaves. Kept as `fixme` rather than deleted, because the reproduction
// is the hard part — the next attempt should start here, probably by stashing the caret per block anchor at
// teardown instead of trying to carry it through the mount.
test("#502: a peer who EDITS then leaves must not move my caret", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctxA = await browser.newContext(); const a = await ctxA.newPage();
  const id = await openScratch(a, `coedit502edit-${Date.now()}`);
  await enterEdit(a);
  await a.click("[data-pane=preview] .cm-content");
  await a.keyboard.insertText(DOC);
  await sleep(900);
  const ctxB = await browser.newContext(); const b = await ctxB.newPage();
  await b.goto(`/p/${id}`); await b.waitForSelector("[data-pane=preview] .cm-content");
  await enterEdit(b); await sleep(800);
  await enterIsland(a);
  await setIslandCaret(a, 12);
  await enterIsland(b);
  await sleep(1400);
  await b.keyboard.type("ZZ");
  await sleep(600);
  await b.keyboard.press("Escape");
  await sleep(1800);
  const after = await islandCaret(a);
  expect(after, `A's caret survives the peer editing and leaving (got ${after})`).toBeGreaterThan(8);
  await ctxA.close(); await ctxB.close();
});

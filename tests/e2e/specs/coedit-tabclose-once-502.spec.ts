import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #502 review follow-up: the reviewer found that the duplication class was not fully closed — a peer who
// closes their TAB (rather than pressing Escape) had their edit written twice. Both the leaving client and
// the staying one flushed the merged body, neither could see the other's in-flight write, and Yjs merged
// two inserts. This pins the elected-writer rule that fixes it, on the exact document string.
const DOC = "# t\n\n```mermaid\ngraph TD\n  A[start] --> B[end]\n```\n\nafter\n";
const docText = (p: Page) => p.evaluate(() => {
  const ed = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
  const view = (ed?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as
    { state: { doc: { toString(): string } } };
  return view.state.doc.toString();
});
async function enterIsland(p: Page) {
  await p.click("[data-pane=preview] .cm-content");
  await p.keyboard.press("Control+Home"); await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown");
  await sleep(200); await p.keyboard.press("Control+Enter"); await sleep(900);
}
test("#502: a peer closing their tab mid-edit lands the edit ONCE", async ({ browser }) => {
  const ctxA = await browser.newContext(); const a = await ctxA.newPage();
  const id = await openScratch(a, `tabclose502-${Date.now()}`);
  await enterEdit(a); await a.click("[data-pane=preview] .cm-content");
  await a.keyboard.insertText(DOC); await sleep(1000);
  const ctxB = await browser.newContext(); const b = await ctxB.newPage();
  await b.goto(`/p/${id}`); await b.waitForSelector("[data-pane=preview] .cm-content");
  await enterEdit(b); await sleep(800);
  await enterIsland(a); await enterIsland(b);
  await b.keyboard.press("Control+End"); await b.keyboard.type("QRS"); await sleep(600);
  await ctxB.close();          // B closes the tab WITHOUT Escape
  await sleep(2000);
  // Exact string: every co-occupant used to flush on teardown, so the leaver and the stayer wrote the
  // same text concurrently and Yjs merged both — "QRS" landed as "QRSQRS". One elected writer now.
  expect(await docText(a), "the peer's edit is in the canon exactly once")
    .toBe("# t\n\n```mermaid\ngraph TD\n  A[start] --> B[end]QRS\n```\n\nafter\n");
  await ctxA.close();
});

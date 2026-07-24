import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #502 review rejection (2026-07-27): "the second person can't get into the island, and it breaks". Traced
// with this two-client harness: the RichUI DID mount for the second client and was torn down 30ms later.
// Destroying the old surface during the co-edit bind SWAP blurs it, blur is the commit trigger, and that
// commit's dispatch re-rendered the block and closed the island. The same commit would have written an
// EMPTY body to the canonical text had the bind happened before the peer's seed replicated — the data-loss
// path the reject suspected. The fix suppresses commits for the duration of the swap (an internal re-mount
// is not the user leaving). This pins the outcome: with a peer already inside, the second client's island
// STAYS, and neither client's text is lost.

const BODY = "hello from the callout";
const DOC = `:::note\n${BODY}\n:::\n\nafter\n`;
const docText = (p: Page) => p.evaluate(() => {
  const ed = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
  const view = (ed?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as
    { state: { doc: { toString(): string } } };
  return view.state.doc.toString();
});
const islandUp = (p: Page) => p.evaluate(() => !!document.querySelector(".cm-lp-editui-wrap"));
async function enterIsland(p: Page) {
  await p.click("[data-pane=preview] .cm-content");
  await p.keyboard.press("Control+Home");
  await sleep(200);
  await p.keyboard.press("Control+Enter");
  await sleep(900);
}

test("#502: a second client entering an occupied island keeps it open, and no text is lost", async ({ browser }) => {
  const ctxA = await browser.newContext(); const a = await ctxA.newPage();
  const id = await openScratch(a, `coedit502v-${Date.now()}`);
  await enterEdit(a);
  await a.click("[data-pane=preview] .cm-content");
  await a.keyboard.insertText(DOC);
  await sleep(900);
  const ctxB = await browser.newContext(); const b = await ctxB.newPage();
  await b.goto(`/p/${id}`); await b.waitForSelector("[data-pane=preview] .cm-content");
  await enterEdit(b); await sleep(800);

  await enterIsland(a);
  expect(await islandUp(a), "the first client's island is open").toBe(true);
  await enterIsland(b);
  await sleep(1200); // well past the 30ms teardown the trace measured
  expect(await islandUp(b), "the second client's island must not be torn down by the co-edit bind").toBe(true);
  expect(await docText(a), "and the body survives on the first client").toContain(BODY);
  expect(await docText(b), "…and on the second").toContain(BODY);
  await ctxA.close(); await ctxB.close();
});

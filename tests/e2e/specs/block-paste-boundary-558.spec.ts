import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #558: #549 made "click the block → Ctrl+C" copy the whole source; the natural follow-up — arrow the
// caret next to the atom and Ctrl+V — spliced that multi-line chunk into whatever line the caret sat on.
// Measured before the fix (the RED this spec was born from): ArrowRight out of a mermaid atom parks the
// caret INSIDE the "```mermaid" marker line (head 18 of line [17,27]), and the paste produced
// "`````mermaid" — the marker line split in two, the document's notation broken. The receiver now
// normalizes a COMPLETE block chunk to a line boundary (block-paste.ts); ordinary text pastes are
// untouched. Real gestures, real clipboard — the #549lesson (no synthetic events).

const FIXTURE = [
  "intro paragraph",
  "",
  "```mermaid",
  "graph TD; A-->B;",
  "```",
  "",
  ":::note[Label]",
  "callout body",
  ":::",
  "",
  "::::tabs",
  ":::tab[One]",
  "one pane",
  ":::",
  "::::",
  "",
  "tail paragraph",
  "",
].join("\n");

async function author(page: Page): Promise<void> {
  await openScratch(page, `bp558-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view to write the fixture into");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, FIXTURE);
  await sleep(2000);
}

const docText = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: { state: { doc: { toString(): string } } } }; cmTile?: { view?: { state: { doc: { toString(): string } } } } } | null;
    return (el?.cmView?.view ?? el?.cmTile?.view)!.state.doc.toString();
  });

// atom select → copy → arrow → paste; then the doc must hold TWO intact copies of the chunk.
async function copyArrowPaste(page: Page, atom: ReturnType<Page["locator"]>, arrow: "ArrowRight" | "ArrowLeft"): Promise<string> {
  await atom.click();
  await sleep(300);
  await page.keyboard.press("Control+c");
  await sleep(200);
  await page.keyboard.press(arrow);
  await sleep(200);
  await page.keyboard.press("Control+v");
  await sleep(500);
  return docText(page);
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

test("#558: a copied mermaid block pastes intact at the ArrowRight edge (the measured corruption)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await author(page);
  const doc = await copyArrowPaste(page, page.locator("[data-pane=preview] [data-testid=macro-mermaid]").first(), "ArrowRight");
  expect(doc, "no marker line was split (RED produced `````mermaid)").not.toMatch(/````/);
  expect(count(doc, "```mermaid\ngraph TD; A-->B;\n```"), "two intact mermaid blocks").toBe(2);
  await sleep(1200);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]"), "…and both render").toHaveCount(2);
});

test("#558: the ArrowLeft edge keeps the block whole and on its own lines too", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await author(page);
  const doc = await copyArrowPaste(page, page.locator("[data-pane=preview] [data-testid=macro-mermaid]").first(), "ArrowLeft");
  expect(doc).not.toMatch(/````/);
  expect(count(doc, "```mermaid\ngraph TD; A-->B;\n```"), "two intact mermaid blocks").toBe(2);
  expect(doc, "the paste never lands mid-line: every opener starts a line").not.toMatch(/[^\n]```mermaid/);
});

test("#558: a directive block (:::note) survives the same gesture", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await author(page);
  const doc = await copyArrowPaste(page, page.locator("[data-pane=preview] [data-testid=callout-panel]").first(), "ArrowRight");
  expect(count(doc, ":::note[Label]\ncallout body\n:::"), "two intact callout blocks").toBe(2);
  expect(doc, "no marker got glued onto another line").not.toMatch(/[^\n]:::note/);
  await expect(page.locator("[data-pane=preview] [data-testid=callout-panel]")).toHaveCount(2);
});

test("#558: a container block (tabs) survives the same gesture", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await author(page);
  const doc = await copyArrowPaste(page, page.locator("[data-pane=preview] .cm-lp-tabs").first(), "ArrowRight");
  expect(count(doc, "::::tabs\n:::tab[One]\none pane\n:::\n::::"), "two intact tabs blocks").toBe(2);
  await sleep(800);
  await expect(page.locator("[data-pane=preview] .cm-lp-tabs")).toHaveCount(2);
});

test("#558 over-application guard: ordinary text still pastes at the caret, mid-line", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await author(page);
  // copy ordinary text through the editor's own copy (select the word "intro" on line 1)
  await page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: { dispatch(t: unknown): void } }; cmTile?: { view?: { dispatch(t: unknown): void } } } | null;
    (el?.cmView?.view ?? el?.cmTile?.view)!.dispatch({ selection: { anchor: 0, head: 5 } });
  });
  await page.keyboard.press("Control+c");
  await sleep(200);
  // park the caret MID-line in the tail paragraph (between "tail" and "paragraph") and paste
  await page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: { state: { doc: { toString(): string } }; dispatch(t: unknown): void } }; cmTile?: { view?: { state: { doc: { toString(): string } }; dispatch(t: unknown): void } } } | null;
    const v = (el?.cmView?.view ?? el?.cmTile?.view)!;
    const pos = v.state.doc.toString().indexOf("tail ") + 5;
    v.dispatch({ selection: { anchor: pos } });
  });
  await page.keyboard.press("Control+v");
  await sleep(400);
  const doc = await docText(page);
  expect(doc, "plain text landed exactly at the caret — no boundary hop").toContain("tail intro");
});

import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #543: entering a slot island exposed the raw markers of whatever macro the slot BEGAN with — ```
// backticks for a leading fence, ::: for a leading directive. The island mounts with the CREATE-time
// default selection (an empty caret at 0) that nobody chose, and Live's caret-in reveal followed it.
// The fix (selectionTouched) makes the reveal predicates ignore a selection that was never actually
// SET; the first real interaction (click, keystroke — both dispatch) restores every existing reveal
// behaviour, which the last test pins as top-level parity.
const DOC = "::::columns\n:::column\n```mermaid\ngraph TD; A-->B;\n```\n:::\n:::column\nBBB\n:::\n::::\n\n::::tabs\n:::tab[One]\n:::note\nhello\n:::\n:::\n:::tab[Two]\ntwo\n:::\n::::\n";

// Matrix variant: fence inside tabs / table directive inside columns (the ticket's cells).
const DOC2 = "::::columns\n:::column\n:::table\n<table><tr><td>x</td></tr></table>\n:::\n:::\n:::column\nBBB\n:::\n::::\n\n::::tabs\n:::tab[One]\n```mermaid\ngraph TD; C-->D;\n```\n:::\n:::tab[Two]\ntwo\n:::\n::::\n";

async function islandRawMarkers(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const island = document.querySelector(".cm-lp-slot-edit-island");
    if (!island) return null;
    const walker = document.createTreeWalker(island, NodeFilter.SHOW_TEXT);
    const visible: string[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const el = (n.parentElement as HTMLElement);
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const t = (n.textContent || "").trim();
      if (t) visible.push(t);
    }
    const joined = visible.join("|");
    return { backticks: joined.includes("```"), colons: /(^|\|):{3}/.test(joined) };
  });
}

async function setupPage(browser: import("@playwright/test").Browser, doc: string, tag: string) {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `n543-${tag}-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(doc);
  await sleep(1500);
  return page;
}

test("#543: a columns island whose slot begins with a fence opens with the fence RENDERED", async ({ browser }) => {
  const page = await setupPage(browser, DOC, "a");
  await page.locator("[data-pane=preview] .cm-lp-columns .cm-lp-column").first().click();
  await sleep(900);
  const r = await islandRawMarkers(page);
  expect(r, "the island opened").not.toBeNull();
  expect(r!.backticks, "no raw backticks on entry").toBe(false);
  expect(r!.colons, "no raw ::: on entry").toBe(false);
});

test("#543: a tabs island whose slot begins with a callout opens with the callout RENDERED", async ({ browser }) => {
  const page = await setupPage(browser, DOC, "b");
  await page.locator("[data-pane=preview] .cm-lp-tabs .cm-lp-tabpanel-active").first().click();
  await sleep(900);
  const r = await islandRawMarkers(page);
  expect(r).not.toBeNull();
  expect(r!.colons, "no raw ::: on entry").toBe(false);
  expect(r!.backticks).toBe(false);
});

test("#543 matrix: table-in-columns and fence-in-tabs enter clean too", async ({ browser }) => {
  const page = await setupPage(browser, DOC2, "c");
  await page.locator("[data-pane=preview] .cm-lp-columns .cm-lp-column").first().click();
  await sleep(900);
  const r1 = await islandRawMarkers(page);
  expect(r1).not.toBeNull();
  expect(r1!.colons, "columns × :::table: no raw markers").toBe(false);
  // leave the island, then enter the tabs island
  await page.keyboard.press("Escape");
  await sleep(700);
  await page.locator("[data-pane=preview] .cm-lp-tabs .cm-lp-tabpanel-active").first().click();
  await sleep(900);
  const r2 = await islandRawMarkers(page);
  expect(r2).not.toBeNull();
  expect(r2!.backticks, "tabs × fence: no raw backticks").toBe(false);
});

test("#543 parity guard: a real interaction still reveals — in the island and at top level", async ({ browser }) => {
  const page = await setupPage(browser, DOC, "d");
  // Top level: clicking the rendered mermaid reveals its raw source (#243 behaviour, unchanged).
  await page.locator("[data-pane=preview] .cm-lp-columns .cm-lp-column").first().click();
  await sleep(900);
  // Inside the island: click the rendered nested mermaid → caret lands in the fence → reveal (the
  // very same caret-in behaviour top level has; only the un-chosen mount default is ignored).
  const nested = page.locator(".cm-lp-slot-edit-island [data-testid=macro-mermaid], .cm-lp-slot-edit-island .cm-lp-macro-wrap").first();
  await nested.click();
  await sleep(700);
  const r = await islandRawMarkers(page);
  expect(r).not.toBeNull();
  expect(r!.backticks, "a deliberate click still reveals the fence raw (parity kept)").toBe(true);
});

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
      //the vim fat cursor's glyph is blanked by making it COLOR-transparent (the #238 guard)
      // — an invisible glyph is not an exposed marker, so transparent text is excluded like hidden.
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0 || cs.color === "rgba(0, 0, 0, 0)") continue;
      const t = (n.textContent || "").trim();
      if (t) visible.push(t);
    }
    const joined = visible.join("|");
    // anyBacktick: the vim × Live leak was a SINGLE visible "`" (the fat cursor painting the raw doc
    // char) — "```"-only detection missed it, which is how the first fix shipped half-done.
    // anyColon mirrors anyBacktick for directive slots (the fat cursor paints ":" there); the
    // fixtures deliberately contain no legitimate visible ":" so a single one IS the leak.
    return { backticks: joined.includes("```"), colons: /(^|\|):{3}/.test(joined), anyBacktick: joined.includes("`"), anyColon: joined.includes(":") };
  });
}

async function setupPage(browser: import("@playwright/test").Browser, doc: string, tag: string, vim = false) {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `n543-${tag}-${Date.now().toString(36)}`);
  await enterEdit(page);
  if (vim) {
    await page.getByTestId("vim-toggle").click();
    await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-pressed", "true");
  }
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  if (vim) await page.keyboard.press("i"); // INSERT so the doc types in
  await page.keyboard.insertText(doc);
  if (vim) await page.keyboard.press("Escape"); // back to NORMAL — the reported mode
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

// ──the vim axis. The first fix shipped with non-vim pins only and the reporter uses
// vim × Live: the island mounts, focuses and paints WITHOUT a transaction, and the vim fat cursor
// painted the raw fence char under the mount caret (a single visible "`"). The blank guard now rides
// editorAttributes (evaluated at construction, survives CM's focus className rebuild), and every
// entry cell is pinned WITH vim — a keymap axis this screen family must carry (the the project design notes vim
// invariants' lesson, measured here).
test("#543 vim: columns × fence enters with NO visible raw glyph (thereport)", async ({ browser }) => {
  const page = await setupPage(browser, DOC, "va", true);
  await page.locator("[data-pane=preview] .cm-lp-columns .cm-lp-column").first().click();
  await sleep(900);
  const r = await islandRawMarkers(page);
  expect(r, "the island opened").not.toBeNull();
  expect(r!.anyBacktick, "no visible backtick — not even the fat cursor's single glyph").toBe(false);
  expect(r!.colons).toBe(false);
});

test("#543 vim: tabs × callout enters clean", async ({ browser }) => {
  const page = await setupPage(browser, DOC, "vb", true);
  await page.locator("[data-pane=preview] .cm-lp-tabs .cm-lp-tabpanel-active").first().click();
  await sleep(900);
  const r = await islandRawMarkers(page);
  expect(r).not.toBeNull();
  expect(r!.anyColon, "no visible colon — not even the fat cursor's single glyph").toBe(false);
  expect(r!.anyBacktick).toBe(false);
});

test("#543 vim matrix: table-in-columns and fence-in-tabs enter clean", async ({ browser }) => {
  const page = await setupPage(browser, DOC2, "vc", true);
  await page.locator("[data-pane=preview] .cm-lp-columns .cm-lp-column").first().click();
  await sleep(900);
  const r1 = await islandRawMarkers(page);
  expect(r1).not.toBeNull();
  expect(r1!.anyColon, "vim: columns × :::table clean (single glyph included)").toBe(false);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape"); // vim: first Esc may only settle mode — island exit next
  await sleep(700);
  await page.locator("[data-pane=preview] .cm-lp-tabs .cm-lp-tabpanel-active").first().click();
  await sleep(900);
  const r2 = await islandRawMarkers(page);
  expect(r2).not.toBeNull();
  expect(r2!.anyBacktick, "vim: tabs × fence clean").toBe(false);
});

test("#543 vim non-regression: island editing still works (i → type lands; motion doesn't leak)", async ({ browser }) => {
  const page = await setupPage(browser, DOC, "vd", true);
  await page.locator("[data-pane=preview] .cm-lp-columns .cm-lp-column").first().click();
  await sleep(900);
  const island = page.locator("[data-testid=slot-edit-island]");
  await expect(island).toHaveCount(1);
  // A DELIBERATE caret move (j) then insert — the guard must not swallow vim's legitimate editing.
  await page.keyboard.press("j");
  await sleep(200);
  await page.keyboard.press("i");
  await page.keyboard.type("VIMEDIT ");
  await sleep(300);
  expect(await island.locator(".cm-content").first().innerText(), "typed text landed in the island").toContain("VIMEDIT");
  // …and a deliberate interaction still reveals raw (the parity rule, vim flavour): Esc to NORMAL,
  // gg to the fence head — a chosen caret ON the fence line reveals like top level does.
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg");
  await sleep(500);
  const r = await islandRawMarkers(page);
  expect(r).not.toBeNull();
  expect(r!.backticks, "a deliberate vim motion onto the fence still reveals (parity kept)").toBe(true);
});

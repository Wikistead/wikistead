import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// ADR-024 1b: a macro is an ATOM. It renders in vim (no auto-reveal), vim j/k step OVER it
// as a single motion stop (crucially for a TALL multi-line macro — a short one never
// overshoots, which is why earlier empty-macro traces passed while the device failed), it
// is highlighted when the caret is on it, entered explicitly (Ctrl+Enter), and dd removes
// the WHOLE macro. We build a TALL non-empty mermaid via insertText (paste-like — bypasses
// the editor's per-char auto-close/auto-pair that mangles typed fences).
// Doc lines: 1 top · 2-6 ```mermaid (3 body lines) · 7 mid · 8 bot · 9 (trailing).
async function insertTallMermaid(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\ngraph TD\nA-->B\nA-->C\n```\nmid\nbot\n");
  await sleep(400);
}
const blocks = (page: any) => page.evaluate(() => (window as any).__lpBlocks ?? []);
const headLine = (page: any) => page.evaluate(() => (window as any).__lpHeadLine);
async function vimOn(page: any) {
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
}

test("a tall macro is a single atom range covering its whole fence", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-range");
  await enterEdit(page);
  await insertTallMermaid(page);
  // ONE atom whose range spans the whole ```mermaid…``` fence (lines 2-6), not just one line.
  expect(await blocks(page)).toEqual([{ fromLine: 2, toLine: 6 }]);
});

test("vim j/k step over a TALL macro atom as ONE stop; gg/G not hijacked", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-motion");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);

  await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(110);
  expect(await headLine(page)).toBe(1); // gg → top, not hijacked
  await page.keyboard.press("j"); await sleep(100);
  expect(await headLine(page)).toBe(2); // lands ON the atom (one stop)
  await page.keyboard.press("j"); await sleep(100);
  expect(await headLine(page)).toBe(7); // steps off PAST the whole atom (skips 3-6), NO overshoot to 8
  // up direction from the line just below the atom: one stop on the atom, then past it.
  await page.keyboard.press("k"); await sleep(100);
  expect(await headLine(page)).toBe(6); // lands ON the atom from below (one stop)
  await page.keyboard.press("k"); await sleep(100);
  expect(await headLine(page)).toBe(1); // steps off PAST the atom up to top (skips 5-2)

  await page.keyboard.press("G"); await sleep(100);
  expect(await headLine(page)).toBeGreaterThanOrEqual(8); // G → last line, not hijacked onto the atom
});

test("the atom is highlighted only when the caret is on it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-hl");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(110);
  expect(await page.locator("[data-pane=preview] .cm-lp-atom-sel").count()).toBe(0); // on top
  await page.keyboard.press("j"); await sleep(110);
  expect(await page.locator("[data-pane=preview] .cm-lp-atom-sel").count()).toBe(1); // on atom
});

test("Ctrl+Enter enters the atom (reveals the macro source)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-enter");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await page.keyboard.press("j"); await sleep(110);
  expect((await blocks(page)).length).toBe(1); // rendered atom
  await page.keyboard.press("Control+Enter"); await sleep(200);
  // entered → raw source revealed (the fence drops out of the atom blocks)
  expect((await blocks(page)).length).toBe(0);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("```mermaid");
});

test("dd on a TALL macro atom deletes the whole macro verbatim", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-dd");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await page.keyboard.press("j"); await sleep(110); // land on atom
  await page.keyboard.press("d"); await page.keyboard.press("d"); await sleep(200);
  expect((await blocks(page)).length).toBe(0); // macro gone
  const text = (await page.locator("[data-pane=preview] .cm-content").innerText()).replace(/\n+/g, "|").replace(/\|$/, "");
  expect(text).toBe("top|mid|bot"); // whole fence removed verbatim; surrounding lines intact
});

// ADR-024 1b (Mode A): after dd the unnamed register holds the WHOLE macro, so p pastes
// the whole macro back (not just its first line).
test("dd then p pastes the whole macro back", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-ddp");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await page.keyboard.press("j"); await sleep(110);
  await page.keyboard.press("d"); await page.keyboard.press("d"); await sleep(150);
  expect((await blocks(page)).length).toBe(0); // macro gone
  await page.keyboard.press("p"); await sleep(200);
  expect((await blocks(page)).length).toBe(1); // whole macro pasted back (register held the whole macro)
});

// ADR-024 1b: a TALL RENDERED widget (mermaid SVG ~380px) mounts its SVG asynchronously;
// without re-measuring, every line BELOW it kept a stale visual-y and vim j/k drifted
// across the whole region under the widget. A ResizeObserver → view.requestMeasure() keeps
// CM's line geometry in sync. This guards that motion below a tall rendered macro is
// exactly one doc line per key (uses flowchart syntax, which renders here, not the
// env-flaky `graph TD;`).
test("motion below a TALL RENDERED mermaid is one doc line per key (no drift)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-tall-render");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n  A --> B\n  B --> C\n  C --> D\n```\nB0\nB1\nB2\nB3\n");
  await sleep(2500); // let the SVG mount → the widget becomes tall (~380px)
  const svgH = await page.evaluate(() => { const m = document.querySelector("[data-pane=preview] [data-testid=macro-mermaid]") as HTMLElement; return m ? Math.round(m.getBoundingClientRect().height) : 0; });
  expect(svgH).toBeGreaterThan(120); // genuinely tall
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  const head = async () => page.evaluate(() => (window as any).__lpHeadLine);
  // descend from the first line below the widget; each j must advance exactly one doc line.
  await page.getByText("B0", { exact: true }).click();
  await sleep(120);
  let prev = await head();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("j");
    await sleep(90);
    const cur = await head();
    expect(cur).toBe(prev + 1); // no 2-line drift below the tall widget
    prev = cur;
  }
});

// ADR-024 1b (common resize path): a tall TABLE — like mermaid — must not drift the lines
// below it. The resize observer is now on EVERY block widget (macro/table/image/table-edit),
// so a height change of any kind re-measures CM.
test("motion below a TALL table is one doc line per key (no drift)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-tall-table");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  let rows = "| A | B |\n| - | - |\n";
  for (let i = 0; i < 12; i++) rows += `| r${i} | v${i} |\n`;
  await page.keyboard.insertText("top\n" + rows + "\nB0\nB1\nB2\nB3\n");
  await sleep(500);
  const tH = await page.evaluate(() => { const t = document.querySelector("[data-pane=preview] table.cm-lp-table") as HTMLElement; return t ? Math.round(t.getBoundingClientRect().height) : 0; });
  expect(tH).toBeGreaterThan(120); // genuinely tall
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  const head = async () => page.evaluate(() => (window as any).__lpHeadLine);
  await page.getByText("B0", { exact: true }).click();
  await sleep(120);
  let prev = await head();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("j");
    await sleep(90);
    const cur = await head();
    expect(cur).toBe(prev + 1); // no drift below the tall table
    prev = cur;
  }
});

// ADR-024 1b (Tier2 churn fix): MacroWidget.eq compares the registry `name`, not the
// per-render `macro` object (the directive renderer passes a fresh { liveRender } literal
// each time). Otherwise the :::table widget is recreated on EVERY selection change, which
// re-measures the table async while vim computes motion sync from stale geometry → drift
// below the table. Guard: the rendered :::table DOM node is REUSED across selection changes.
test("a :::table widget is reused (not recreated) across selection changes", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-table-reuse");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| A | B |\n| - | - |\n| 1 | 2 |\n\nL0\nL1\nL2\n");
  await sleep(300);
  // promote the pipe table to a :::table (a cell colour → Tier2 HTML)
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
  await sleep(250);
  await page.getByTestId("table-edit").locator("td").first().click();
  await sleep(150);
  await page.getByTestId("table-bg-green").click();
  await sleep(250);
  await page.keyboard.press("Escape");
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-table]")).toBeVisible();
  // tag the node, then change the selection repeatedly below the table
  await page.evaluate(() => { (document.querySelector("[data-pane=preview] [data-testid=macro-table]") as any).__mark = "KEEP"; });
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.getByText("L0", { exact: true }).click();
  await sleep(120);
  for (let i = 0; i < 4; i++) { await page.keyboard.press("j"); await sleep(60); await page.keyboard.press("k"); await sleep(60); }
  // SAME node still present (a recreated widget would lose the JS property)
  const reused = await page.evaluate(() => (document.querySelector("[data-pane=preview] [data-testid=macro-table]") as any)?.__mark === "KEEP");
  expect(reused).toBe(true);
});

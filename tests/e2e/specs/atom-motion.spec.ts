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

// ADR-024: entering a source macro lands in the vim NORMAL world — Ctrl+Enter must NOT
// force insert mode (a vim user moves with hjkl; `i` first enters insert). A stale-HMR
// device report claimed forced-insert; this locks in the verified contract so a real
// regression (something dispatching insert on entry) fails here.
const vimInsert = (page: any) => page.evaluate(() => (window as any).__lpVimInsert);
test("Ctrl+Enter into a source macro stays in vim NORMAL (no forced insert)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-enter-normal");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await page.keyboard.press("j"); await sleep(110);
  await page.keyboard.press("Control+Enter"); await sleep(200);
  expect(await vimInsert(page)).toBe(false); // entered → NORMAL, not insert
  // j is normal-mode motion (caret moves) — proof keys reach vim as commands, not typing.
  const head0 = await headLine(page);
  await page.keyboard.press("j"); await sleep(80);
  expect(await headLine(page)).not.toBe(head0); // moved
  // i NOW enters insert (insert is reached explicitly, not forced on entry)
  await page.keyboard.press("i"); await sleep(80);
  expect(await vimInsert(page)).toBe(true);
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

// #91: yy on a macro atom yanks the WHOLE macro (the read counterpart of dd). yy changes no
// doc, so we move past the atom and paste: p brings the whole macro back as a 2nd atom.
test("yy on a TALL macro atom yanks the whole macro; p pastes it back whole", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-yy");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await page.keyboard.press("j"); await sleep(110); // land on atom
  await page.keyboard.press("y"); await page.keyboard.press("y"); await sleep(150);
  expect((await blocks(page)).length).toBe(1); // yy doesn't change the doc — the macro is still there
  await page.keyboard.press("G"); await sleep(110); // move below the macro so p doesn't land mid-fence
  await page.keyboard.press("p"); await sleep(200);
  expect((await blocks(page)).length).toBe(2); // the WHOLE macro pasted as a second atom
});

// #91 (review fix): the dd/yy atom handling must work for a `:::table` DIRECTIVE atom,
// not only a ```fence``` macro — the owner reported yy on `:::table` copying just the `:::`
// opening line. A directive's atom block range is resolved differently (first.from..lastLine.to,
// not the fence node) so it gets its own coverage. Doc lines: 1 top · 2-6 :::table (3 body
// lines) · 7 mid · 8 bot.
async function insertTallTable(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n:::table\n<table>\n<tr><td>CELLDATA</td><td>b</td></tr>\n</table>\n:::\nmid\nbot\n");
  await sleep(400);
}

test(":::table directive is a single atom spanning its whole block", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tbl-atom-range");
  await enterEdit(page);
  await insertTallTable(page);
  expect(await blocks(page)).toEqual([{ fromLine: 2, toLine: 6 }]); // whole :::table…::: , not just line 2
});

test("dd on a :::table directive atom deletes the whole block verbatim", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tbl-dd");
  await enterEdit(page);
  await insertTallTable(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await page.keyboard.press("j"); await sleep(110); // land on atom
  await page.keyboard.press("d"); await page.keyboard.press("d"); await sleep(200);
  expect((await blocks(page)).length).toBe(0); // whole :::table gone, not just the ::: line
  const text = (await page.locator("[data-pane=preview] .cm-content").innerText()).replace(/\n+/g, "|").replace(/\|$/, "");
  expect(text).toBe("top|mid|bot");
  // #91 content regression: dd's register holds the WHOLE block, so p restores it WITH content.
  await page.keyboard.press("G"); await sleep(110);
  await page.keyboard.press("p"); await sleep(200);
  expect((await blocks(page)).length).toBe(1); // the macro is back…
  expect((await page.locator("[data-pane=preview] .cm-content").innerText()).match(/CELLDATA/g)?.length).toBe(1); // …with its cell body
});

test("yy on a :::table directive atom yanks the whole block; p pastes it back whole", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tbl-yy");
  await enterEdit(page);
  await insertTallTable(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await page.keyboard.press("j"); await sleep(110); // land on atom
  await page.keyboard.press("y"); await page.keyboard.press("y"); await sleep(150);
  expect((await blocks(page)).length).toBe(1); // yy doesn't change the doc
  await page.keyboard.press("G"); await sleep(110); // below the block so p doesn't land mid-block
  await page.keyboard.press("p"); await sleep(200);
  expect((await blocks(page)).length).toBe(2); // WHOLE :::table pasted as a 2nd atom (not a lone ::: line)
  // #91 content regression: the pasted atom must carry the CELL CONTENT, not an empty frame.
  // (A lone `:::table` yank pastes an "Empty table" — block count alone would not catch that.)
  const txt = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect((txt.match(/CELLDATA/g) || []).length).toBe(2); // original + pasted, both with the cell body
});

// #91 regression: the intercept only fires on an atom's first line. yy on a NORMAL line still
// yanks exactly that one line (passes through to vim) — binding `y` must not break plain yy.
test("yy on a normal line still yanks just that line (passes through to vim)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-yy-plain");
  await enterEdit(page);
  await insertTallMermaid(page);
  await vimOn(page);
  await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(110); // line 1 "top"
  await page.keyboard.press("y"); await page.keyboard.press("y"); await sleep(120);
  await page.keyboard.press("p"); await sleep(150); // paste below line 1
  expect((await blocks(page)).length).toBe(1); // no new macro (only one line was yanked)
  const text = (await page.locator("[data-pane=preview] .cm-content").innerText());
  expect(text.split("top").length - 1).toBe(2); // "top" now appears twice (line duplicated)
});

// ADR-024 1b: a TALL RENDERED widget (mermaid SVG ~380px) mounts its SVG asynchronously;
// without re-measuring, every line BELOW it kept a stale visual-y and vim j/k drifted
// across the whole region under the widget. A ResizeObserver → view.requestMeasure keeps
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
  await page.locator("[data-pane=preview] table.cm-lp-table").click(); await sleep(150); await page.keyboard.press("Control+Enter"); // #216: pipe×Live RichUI = Ctrl+Enter opt-in
  await sleep(250);
  await page.getByTestId("table-edit").locator("td").first().click();
  await sleep(150);
  await page.getByTestId("table-bg-green").click();
  await sleep(250);
  await page.keyboard.press("Escape"); // #154: bg colour commits per-op; Escape exits in-editor edit mode
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

// ADR-024 1b (cumulative drift): block-widget roots used `margin`, which CM EXCLUDES from
// its measured height (getBoundingClientRect), so each widget's heightMap entry was short by
// the margin — invisible for one widget (< a line) but ADDITIVE across stacked widgets, so
// motion below 2+ macros drifted a line. Roots now use padding (counted). Guard: below TWO
// stacked tall mermaids, every key advances exactly one doc line.
test("motion below TWO stacked tall macros is one doc line per key (no cumulative drift)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-stacked");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n  A --> B\n  B --> C\n```\n```mermaid\nflowchart TD\n  D --> E\n  E --> F\n```\nB0\nB1\nB2\nB3\n");
  await sleep(3000); // both SVGs mount (each ~tall)
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").count()).toBe(2);
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  const head = async () => page.evaluate(() => (window as any).__lpHeadLine);
  await page.getByText("B0", { exact: true }).click();
  await sleep(120);
  let prev = await head();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("j");
    await sleep(80);
    const cur = await head();
    expect(cur).toBe(prev + 1); // no cumulative 2-line drift below the stack
    prev = cur;
  }
});

// Regression: a LARGE fence macro already present at load renders as an atom (figure
// shown), NOT the "▶ summary" fold placeholder. The old `autoFoldLargeFenceMacros`
// folded any fence block over ~10 lines on sync, so a big Excalidraw/mermaid body
// opened folded and only rendered once the cursor touched it — contradicting the atom
// model (always rendered, never auto-reveal). We seed a >10-line mermaid, let collab
// persist, RELOAD, enter edit WITHOUT touching the macro, and assert it rendered.
test("a large macro present at load renders as an atom, not a fold placeholder", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, "atom-noautofold");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // 12-line fence (```mermaid + 10 body + ```) — over the old 10-line fold threshold.
  await page.keyboard.insertText(
    "top\n```mermaid\nflowchart TD\nA-->B\nB-->C\nC-->D\nD-->E\nE-->F\nF-->G\nG-->H\nH-->I\n```\nbot\n",
  );
  await sleep(2500); // SVG mounts + collab persists the doc

  // Reload from scratch: the large macro now arrives over the provider at sync time
  // exactly when the old auto-fold fired.
  await page.goto(`/p/${id}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await enterEdit(page);
  await sleep(2500); // sync + render; deliberately NO cursor interaction with the macro

  // The figure is rendered and there is no fold placeholder.
  expect(await page.getByTestId("macro-folded").count()).toBe(0);
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").count()).toBeGreaterThanOrEqual(1);
});

// #183 symptom C (the reviewer's exact repro): 1:$x^2$ · 2:empty · 3:$$…$$ · 4:empty · 5:```js · 6:```.
// Display math ($$…$$) atoms live in mathField, SEPARATE from livePreview.blocks. Before the
// motionAtomProvider fix, blockEntry never saw them, so its motion correction miscounted around the OTHER
// atoms too — j skipped line 5 (1→2→3→4→6) and k warped asymmetrically (6→3→2→1). With math atoms fed to
// the motion facet, j/k step ONE line at a time, symmetric down vs up (the reviewer's "1↔6 1").
// This is the real-machine caret-transition measurement the reviewer required to confirm the fix.
test("#183 symptom C: vim j/k move one line at a time, symmetric, over a math atom + code fence", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim-math-motion");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("$x^2$\n\n$$a^2+b^2$$\n\n```js\n```\n");
  await sleep(400);
  await vimOn(page);
  // the display-math atom is exposed to blockEntry's motion facet (the pre-fix blind spot).
  const mathAtoms = await page.evaluate(() => (window as any).__lpMathAtoms ?? []);
  expect(mathAtoms.length, "display math is a motion atom").toBeGreaterThan(0);

  // down: from the top, press j and record each landing line until it stops advancing.
  await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(120);
  const down: number[] = [await headLine(page)];
  for (let i = 0; i < 8; i++) { await page.keyboard.press("j"); await sleep(110); const h = await headLine(page); if (h === down[down.length - 1]) break; down.push(h); }
  // up: from the bottom, press k symmetrically.
  await page.keyboard.press("G"); await sleep(120);
  const up: number[] = [await headLine(page)];
  for (let i = 0; i < 8; i++) { await page.keyboard.press("k"); await sleep(110); const h = await headLine(page); if (h === up[up.length - 1]) break; up.push(h); }

  // #183: each step advances by EXACTLY one line (no skip / no warp), both directions.
  for (let i = 1; i < down.length; i++) expect(down[i]! - down[i - 1]!, `down step ${i}: ${down.join(",")}`).toBe(1);
  for (let i = 1; i < up.length; i++) expect(up[i - 1]! - up[i]!, `up step ${i}: ${up.join(",")}`).toBe(1);
  // symmetric: k retraces j's lines in reverse (1↔last, one by one).
  expect(up.slice().reverse(), `down ${down.join(",")} vs up ${up.join(",")}`).toEqual(down);
});

// #221: an EMPTY ```mermaid / ```plantuml (a "caret fully lands on it" atom whose 2 source lines render
// as one placeholder) was reported to be vertically ASYMMETRIC on device — j crosses in one, k needs an
// extra press. Measured in a REAL browser (not the happy-dom unit traces that miss layout): it is
// SYMMETRIC — the caret makes exactly ONE stop on the atom in each direction and steps past the far edge,
// and k retraces j's stops in reverse. (A persisting device asymmetry with this green is the known
// stale-Vite-HMR gotcha — hard-reload first.)
for (const lang of ["mermaid", "plantuml"] as const) {
  test(`#221: empty \`\`\`${lang} atom — vim j/k are vertically symmetric (one stop each way)`, async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await openScratch(page, `empty-${lang}`);
    await enterEdit(page);
    await page.click("[data-pane=preview] .cm-content");
    // 1 top · 2 blank · 3-4 ```lang``` (atom) · 5 blank · 6 bot
    await page.keyboard.insertText("top\n\n```" + lang + "\n```\n\nbot\n");
    await sleep(500);
    expect(await blocks(page)).toEqual([{ fromLine: 3, toLine: 4 }]); // the empty fence is ONE atom (lines 3-4)
    await vimOn(page);

    await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(120);
    const down: (number | undefined)[] = [await headLine(page)];
    for (let i = 0; i < 5; i++) { await page.keyboard.press("j"); await sleep(100); const h = await headLine(page); if (h === down[down.length - 1]) break; down.push(h); }
    const up: (number | undefined)[] = [await headLine(page)];
    for (let i = 0; i < 5; i++) { await page.keyboard.press("k"); await sleep(100); const h = await headLine(page); if (h === up[up.length - 1]) break; up.push(h); }

    // exactly ONE stop inside the atom [3,4] each direction (no double-stop / extra press)
    expect(down.filter((l) => l === 3 || l === 4), `down ${down.join(",")}`).toHaveLength(1);
    expect(up.filter((l) => l === 3 || l === 4), `up ${up.join(",")}`).toHaveLength(1);
    // and the same number of presses to traverse top↔bottom both ways (no upward-only extra k)
    expect(up.length, `down ${down.join(",")} vs up ${up.join(",")}`).toBe(down.length);
  });
}

// #221 (the RENDERED gap): the empty-fence tests above and the tall-SOURCE j/k test (top of file) both cover
// atoms whose geometry is STATIC. The device report is about k (UP) specifically, and the case that stayed
// untested is crossing UP over a tall ASYNC-RENDERED widget — the mermaid SVG mounts AFTER load and changes
// the line geometry, so upward motion computed from transiently-stale geometry is exactly where an
// "extra k" could hide (a short/empty macro can't expose it; the project design notes: motion tests need tall/rendered/
// multiple). Measure k UP vs j DOWN across a tall rendered mermaid and a stacked pair: exactly ONE stop in
// the atom each way, and the SAME press count top↔bottom both directions (no upward-only extra k).
async function measureUpDownSymmetry(page: any, inAtom: (l: number | undefined) => boolean) {
  await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(130);
  const down: (number | undefined)[] = [await headLine(page)];
  for (let i = 0; i < 12; i++) { await page.keyboard.press("j"); await sleep(100); const h = await headLine(page); if (h === down[down.length - 1]) break; down.push(h); }
  const up: (number | undefined)[] = [await headLine(page)];
  for (let i = 0; i < 12; i++) { await page.keyboard.press("k"); await sleep(100); const h = await headLine(page); if (h === up[up.length - 1]) break; up.push(h); }
  return { down, up };
}
const inRange = (a: { fromLine: number; toLine: number }) => (l: number | undefined) => l !== undefined && l >= a.fromLine && l <= a.toLine;

test("#221 (rendered): vim k UP over a tall RENDERED mermaid is symmetric with j DOWN (one stop, no extra k)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim221-render");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n  A --> B\n  B --> C\n  C --> D\n```\nB0\nB1\nB2\n");
  await sleep(2500); // SVG mounts → the widget becomes tall (~380px)
  const svgH = await page.evaluate(() => { const m = document.querySelector("[data-pane=preview] [data-testid=macro-mermaid]") as HTMLElement; return m ? Math.round(m.getBoundingClientRect().height) : 0; });
  expect(svgH).toBeGreaterThan(120); // genuinely tall & rendered (not a fold placeholder)
  const [atom] = await blocks(page);
  await vimOn(page);
  const { down, up } = await measureUpDownSymmetry(page, inRange(atom));
  expect(down.filter(inRange(atom)), `down ${down.join(",")}`).toHaveLength(1); // one stop on the atom descending
  expect(up.filter(inRange(atom)), `up ${up.join(",")}`).toHaveLength(1);       // one stop ascending (no double / extra press)
  expect(up.length, `down ${down.join(",")} vs up ${up.join(",")}`).toBe(down.length); // #221: no upward-only extra k
});

test("#221 (rendered): vim k UP over TWO stacked tall RENDERED mermaids is symmetric with j DOWN", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim221-stacked");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n  A --> B\n  B --> C\n```\n```mermaid\nflowchart TD\n  D --> E\n  E --> F\n```\nB0\nB1\nB2\n");
  await sleep(3000); // both SVGs mount
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").count()).toBe(2);
  const bl = await blocks(page); // two atoms
  expect(bl.length).toBe(2);
  const inAnyAtom = (l: number | undefined) => bl.some((a: { fromLine: number; toLine: number }) => inRange(a)(l));
  await vimOn(page);
  const { down, up } = await measureUpDownSymmetry(page, inAnyAtom);
  // exactly one stop on EACH atom in each direction (2 total), no double-stop or extra upward press.
  expect(down.filter(inAnyAtom), `down ${down.join(",")}`).toHaveLength(2);
  expect(up.filter(inAnyAtom), `up ${up.join(",")}`).toHaveLength(2);
  expect(up.length, `down ${down.join(",")} vs up ${up.join(",")}`).toBe(down.length); // #221: symmetric press count
});

// #221 comment 845: landing / passing the caret ON a rendered mermaid must NOT re-render it. Recreating the
// widget on the selection toggle re-runs liveRender → the SVG re-mounts → the "source flickers / height
// wobbles" the reviewer saw while k crossed the atom. updateDOM reuses the DOM on a selection-only change.
// Tag the SVG, land the caret ON the atom, and assert the SAME node survives (and the atom is selected, and
// the raw source never revealed) — a recreated widget would lose the JS marker.
test("#221: landing the caret ON a rendered mermaid reuses it (no re-render / flicker)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim221-noflicker");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n  A --> B\n  B --> C\n```\nbot\n");
  await sleep(2500); // SVG mounts
  await page.evaluate(() => { const s = document.querySelector("[data-pane=preview] [data-testid=macro-mermaid] svg") as HTMLElement & { __mark?: string } | null; if (s) s.__mark = "KEEP"; });
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(120); // line 1 (top)
  await page.keyboard.press("j"); await sleep(200); // lands ON the atom → selected (was the flicker trigger)
  expect(await page.locator("[data-pane=preview] .cm-lp-atom-sel").count()).toBe(1); // the atom IS selected
  // the SAME svg node survived → the widget was REUSED (updateDOM), not rebuilt → no SVG re-mount / flicker.
  const reused = await page.evaluate(() => (document.querySelector("[data-pane=preview] [data-testid=macro-mermaid] svg") as (HTMLElement & { __mark?: string }) | null)?.__mark === "KEEP");
  expect(reused).toBe(true);
  // and the raw ```mermaid source did NOT reveal on the caret landing (atom stays rendered).
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("```mermaid");
});

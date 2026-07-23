import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #393 / ADR-151 (+ theaddendum): whole-table BLOCK alignment via the `:::table{align=…}`
// directive attribute. LEFT is the default — a table's natural flow position — so it writes NO
// attribute and adds no class; centre and right are explicit and really move the table. (v1 borrowed
// the diagram convention where the default is centre, which made "centre" write nothing at all and
// therefore render left: centring a table was impossible.) GFM pipe tables are left by definition and
// carry no attribute, so picking centre/right promotes them to `:::table{align=…}`.
const TABLE = ":::table\n<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>\n:::";

const srcText = async (p: Page) => {
  await p.getByTestId("displaymode-source").click();
  await sleep(250);
  return p.locator("[data-pane=preview] .cm-content").innerText();
};

test("#393: right-click a :::table → Align right writes {align=right}; left drops it (round-trip)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-align-393");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`${TABLE}\n\nbelow\n`);
  await page.getByText("below", { exact: true }).click();
  await sleep(500);

  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await expect(wrap).toBeVisible();
  await expect(wrap).not.toHaveClass(/cm-lp-align-/); // default (left): NO align class — plain flow layout

  await wrap.click({ button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("ctx-item-align-right").click();
  await expect(wrap).toHaveClass(/cm-lp-align-right/, { timeout: 8000 });

  // the table physically moved right (the flex align, not just a class)
  const wrapBox = (await wrap.boundingBox())!;
  const tableBox = (await wrap.locator("table").first().boundingBox())!;
  expect(tableBox.x + tableBox.width).toBeGreaterThan(wrapBox.x + wrapBox.width * 0.6);

  // back to LEFT → the attribute is dropped and, since this grid has no spans, the block returns to
  // plain GFM pipes (Open formats: the default state is the plainest Markdown that can express it).
  await wrap.click({ button: "right" });
  await page.getByTestId("ctx-item-align-left").click();
  await sleep(600);
  // the :::table wrapper is gone entirely — the block is plain pipes again
  await expect(page.locator("[data-pane=preview] .cm-lp-macro-wrap")).toHaveCount(0, { timeout: 8000 });
  const s = await srcText(page);
  expect(s).not.toContain("{align="); // left never persists an attribute
  expect(s).toMatch(/\|\s*A\s*\|\s*B\s*\|/); // …and the round-trip landed on a pipe table
});

test("#393Align center actually CENTRES the table (not the old attribute-less left)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-align-center-393");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`${TABLE}\n\nbelow\n`);
  await page.getByText("below", { exact: true }).click();
  await sleep(500);

  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await wrap.click({ button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("ctx-item-align-center").click();
  await expect(wrap, "centre is a real state with its own class").toHaveClass(/cm-lp-align-center/, { timeout: 8000 });

  // and the table is physically centred: its margins inside the wrap match (this is what "centre
  // doesn't work" meant — the old build wrote no attribute, so the table stayed hard left).
  const wrapBox = (await wrap.boundingBox())!;
  const tableBox = (await wrap.locator("table").first().boundingBox())!;
  const leftGap = tableBox.x - wrapBox.x;
  const rightGap = wrapBox.x + wrapBox.width - (tableBox.x + tableBox.width);
  expect(leftGap, "there is room on the left — the table is not flush against it").toBeGreaterThan(4);
  expect(Math.abs(leftGap - rightGap), `centred within a pixel or two (l=${leftGap} r=${rightGap})`).toBeLessThan(2);
  const s = await srcText(page);
  expect(s, "and centre is written down, since it is not the default").toContain("{align=center}");
});

// ADR-151 addendum 3: a rendered GFM pipe table now carries the SAME hover align segment a
// `:::table` does — not only the right-click menu. Before this change TableWidget built no btnrow and no
// align control at all, so this whole affordance was absent on the pipe path (RED: the macro-align
// element does not exist). It must also actually REVEAL on hover (the #216/present-but-invisible
// trap: a control mounted on .cm-lp-table-wrap but styled only under .cm-lp-macro-wrap:hover).
test("#393 addendum3a rendered pipe table shows the hover align segment and promotes on center", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-align-hover-393");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| A | B |\n| --- | --- |\n| 1 | 2 |\n\nbelow\n");
  await page.getByText("below", { exact: true }).click(); // deselect: the table renders (not raw)
  await sleep(600);

  const wrap = page.locator("[data-pane=preview] .cm-lp-table-wrap").first();
  await expect(wrap, "the pipe table renders as a widget").toBeVisible();
  const align = wrap.getByTestId("macro-align");
  await expect(align, "the align segment is MOUNTED on the pipe table (absent before addendum 3)").toHaveCount(1);

  // it is hidden until hover, then actually revealed (opacity 1) — not present-but-invisible
  await wrap.hover();
  await expect(async () => {
    const op = await align.evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(op).toBeGreaterThan(0.9);
  }).toPass({ timeout: 4000 });

  // picking center on the hover segment promotes the pipe → :::table{align=center}
  await wrap.getByTestId("macro-align-center").click();
  await sleep(600);
  const promoted = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await expect(promoted, "the promoted block renders as a centred :::table").toHaveClass(/cm-lp-align-center/, { timeout: 8000 });
  const s = await srcText(page);
  expect(s).toContain(":::table{align=center}");
});

// ADR-151 addendum 3: while the table RichUI island is open, the WHOLE-TABLE align segment stays
// visible — orthogonal to the toolbar's per-CELL text-align (table-align-* buttons). Before this change
// the edit island exposed only the cell-align toolbar, never the whole-table box align.
test("#393 addendum3the whole-table align segment shows while the edit island is open", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-align-editing-393");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`${TABLE}\n\nbelow\n`);
  await page.getByText("below", { exact: true }).click();
  await sleep(500);

  // open the RichUI island (a :::table enters on a body cell click)
  await page.locator("[data-pane=preview] .cm-lp-macro-wrap").first().locator("td").first().click();
  const island = page.getByTestId("table-edit");
  await expect(island).toBeVisible({ timeout: 8000 });

  // the whole-table align segment lives on the island wrap (distinct from the per-cell table-align-* toolbar)
  const wrap = page.locator("[data-pane=preview] .cm-lp-table-edit").first();
  const align = wrap.getByTestId("macro-align");
  await expect(align, "the whole-table align segment is present while editing (absent before addendum 3)").toHaveCount(1);
  await wrap.hover();
  await expect(async () => {
    const op = await align.evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(op).toBeGreaterThan(0.9);
  }).toPass({ timeout: 4000 });
  // it reflects the current (left) side, and it is a DIFFERENT control from the per-cell align toolbar
  // (which is a contextual bar — attached but revealed only on cell selection, so assert attached, not visible).
  await expect(wrap.getByTestId("macro-align")).toHaveAttribute("data-align", "left");
  await expect(page.getByTestId("table-align-left"), "the per-cell align toolbar is a separate control").toBeAttached();
});

test("#393a GFM pipe table offers alignment and PROMOTES to :::table on centre", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-align-pipe-393");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("| A | B |\n| --- | --- |\n| 1 | 2 |\n\nbelow\n");
  await page.getByText("below", { exact: true }).click();
  await sleep(600);

  const table = page.locator("[data-pane=preview] table").first();
  await expect(table).toBeVisible();
  await table.click({ button: "right" });
  await expect(page.getByTestId("context-menu"), "a pipe table gets the align entries too").toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("ctx-item-align-center")).toBeVisible();
  await page.getByTestId("ctx-item-align-center").click();
  await sleep(600);

  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await expect(wrap, "the promoted block renders as a centred :::table").toHaveClass(/cm-lp-align-center/, { timeout: 8000 });
  let s = await srcText(page);
  expect(s).toContain(":::table{align=center}");
  expect(s).toContain("<table");

  // and back: left returns it to plain pipes (no wrapper left behind)
  await page.getByTestId("displaymode-live").click();
  await sleep(400);
  await page.locator("[data-pane=preview] .cm-lp-macro-wrap").first().click({ button: "right" });
  await page.getByTestId("ctx-item-align-left").click();
  await sleep(600);
  s = await srcText(page);
  expect(s).not.toContain(":::table");
  expect(s).toMatch(/\|\s*A\s*\|\s*B\s*\|/);
});

test("#393: a cell edit preserves the align attribute (the rewrite carries the fence)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-align-keep-393");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`:::table{align=right}\n<table><tr><th>H</th></tr><tr><td>x</td></tr></table>\n:::\n\nbelow\n`);
  await page.getByText("below", { exact: true }).click();
  await sleep(500);
  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await expect(wrap).toHaveClass(/cm-lp-align-right/);

  // enter the in-editor table edit — a `:::table` (richEditUI inline) enters on a body click directly
  // (#154/#395: the pipe×Live Ctrl+Enter opt-in is the OTHER quadrant). Each per-op commit rewrites the
  // :::table source through the host tier.
  await wrap.locator("td").first().click();
  await expect(page.getByTestId("table-edit")).toBeVisible({ timeout: 8000 });
  const cell = page.getByTestId("table-edit").locator("td").first();
  await cell.dblclick();
  await page.keyboard.press("Shift+Home");
  await page.keyboard.type("edited");
  await page.keyboard.press("Enter"); // commit the cell → the doc
  await sleep(300);
  await page.keyboard.press("Escape"); // exit edit mode
  await sleep(400);
  const s = await srcText(page);
  expect(s).toContain(":::table{align=right}"); // the cell edit did NOT strip the block alignment
  expect(s).toContain("edited");
});

test("#393: a nested :::table{align=right} aligns on the read/nested surface too (md-render path)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-align-nested-393");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`::::columns\n:::column\n:::table{align=right}\n<table><tr><td>n</td></tr></table>\n:::\n:::\n:::column\nplain\n:::\n::::\n\nbelow\n`);
  await page.getByText("below", { exact: true }).click();
  await sleep(700);
  // the nested render wraps the table in a fixed-class align wrapper (enum → class, never free text)
  const nestedWrap = page.locator("[data-pane=preview] .cm-lp-column .cm-lp-align-right").first();
  await expect(nestedWrap).toBeVisible({ timeout: 8000 });
  await expect(nestedWrap.locator("table")).toBeVisible();
});

//the sink that renders a table's markdown for READING — `renderMarkdownToDom`, which draws
// nested macro bodies here and is the same visitor the server's HTML export runs — only ever wrapped
// left and right. That was correct while centre was the default and the wrapper's job was to express a
// departure from it, and it silently became wrong when #393 made LEFT the default: an explicit
// `align=center` reached the editor's own decoration and nothing else, so the same source sat centred
// while being written and flush left wherever this visitor drew it. The centre pins above measure the
// editor surface, which is a different renderer, so none of them could see it.
test("#393a nested :::table{align=center} centres on the read surface (md-render path)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-align-center-nested-393");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`::::columns\n:::column\n:::table{align=center}\n<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>\n:::\n:::\n:::column\nplain\n:::\n::::\n\nbelow\n`);
  await page.getByText("below", { exact: true }).click();
  await sleep(700);

  const wrap = page.locator("[data-pane=preview] .cm-lp-column .cm-lp-align-center").first();
  await expect(wrap, "the read sink wraps an explicit centre in the fixed align class").toBeVisible({ timeout: 8000 });
  // …and it has to actually move the table: the class means nothing if the geometry still says left
  const wrapBox = (await wrap.boundingBox())!;
  const tableBox = (await wrap.locator("table").boundingBox())!;
  const leftGap = tableBox.x - wrapBox.x;
  const rightGap = wrapBox.x + wrapBox.width - (tableBox.x + tableBox.width);
  expect(leftGap, `there is room on the left — a centred table is not flush against it (l=${leftGap} r=${rightGap})`).toBeGreaterThan(2);
  expect(Math.abs(leftGap - rightGap), `centred within a pixel or two (l=${leftGap} r=${rightGap})`).toBeLessThan(2);
});

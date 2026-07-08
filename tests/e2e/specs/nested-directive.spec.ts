import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #185 / ADR-096 (Option B): a nested `::::tabs > :::tab > ::::columns > :::column` used to have its
// parent `:::tabs` EARLY-CLOSED by the inner `::::columns` close (lezer's `>=` colon match), which
// orphaned the second tab and leaked it (as a plain paragraph) OUTSIDE the tabs frame. comment 781: the
// resolver fixed the range LAYER (motion/reveal/fence-hide) but the tabs WIDGET body was still sliced
// from lezer's `node.to`, so the widget only split the first tab and the rest leaked. Driving the widget
// range from the resolver (directiveMacroAt) + skipping the orphaned sibling nodes fixes it. This test
// asserts the WIDGET STRUCTURE (both tab buttons, both columns, tab switching), not just marker leak
// the old "innerText contains CCC" passed BECAUSE the second tab leaked as visible text (the bug itself).
test("#185 comment 781: nested tabs>columns builds a real widget — both tabs, both columns, no leak", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openScratch(page, "nested-dir");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(
    "intro\n\n::::tabs\n:::tab[T1]\n::::columns\n:::column\nAAA\n:::\n:::column\nBBB\n:::\n::::\nend of first.\n:::\n:::tab[T2]\nCCC\n:::\n::::\n\noutro\n",
  );
  await sleep(900);
  await page.keyboard.press("Control+End"); // caret OUT of the macro (reveal-on-cursor would show raw otherwise)
  await sleep(300);

  const tabs = page.locator("[data-pane=preview] [data-testid=macro-tabs]");
  await expect(tabs, "the tabs widget rendered").toHaveCount(1);
  // BOTH tab buttons exist (parent tabs did NOT early-close, dropping T2).
  await expect(tabs.locator(".cm-lp-tab")).toHaveText(["T1", "T2"]);
  // The nested columns render BOTH columns (BBB left did not vanish).
  await expect(tabs.locator(".cm-lp-column")).toHaveCount(2);
  const active = tabs.locator(".cm-lp-tabpanel-active");
  await expect(active, "T1 active shows both columns + its trailing text").toContainText("AAA");
  await expect(active).toContainText("BBB");
  await expect(active).toContainText("end of first.");
  // Tab switching: clicking T2 shows CCC (its content is INSIDE the widget, not leaked outside).
  await tabs.locator(".cm-lp-tab", { hasText: "T2" }).click();
  await expect(active).toContainText("CCC");

  // Nothing leaked OUTSIDE the tabs widget: the surrounding paragraphs are the ONLY body text besides the
  // widget, and no raw ::: markers show. (T2's CCC must NOT appear as a stray paragraph under the tabs.)
  const outside = await page.evaluate(() => {
    const root = document.querySelector("[data-pane=preview] .cm-content")!;
    const tabsEl = root.querySelector("[data-testid=macro-tabs]");
    // text of the content with the tabs widget subtree removed
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelector("[data-testid=macro-tabs]")?.remove();
    return { text: clone.innerText, hadTabs: !!tabsEl };
  });
  expect(outside.hadTabs).toBe(true);
  expect(outside.text, "raw ::: / :::: markers leaked").not.toMatch(/:::/);
  expect(outside.text, "T2 content leaked outside the tabs widget").not.toContain("CCC");
  expect(outside.text).toContain("intro");
  expect(outside.text).toContain("outro");
  // No CM overlapping-decoration / render errors.
  expect(errors, errors.join(" | ")).toHaveLength(0);
});

// #196 comment 786 (Option B, variant i): a caret inside a NESTED macro must NOT collapse the container's
// layout. The earlier innermost-wins "frame+descend" reveal stacked the flex columns vertically (the 754
// breakage). Now columns/tabs are always a flex WIDGET (edited via the editUI panel, not caret-in raw), so
// clicking into the nested note keeps the side-by-side layout and leaks NO fence markers. Measured in a real
// browser (layout geometry happy-dom can't exercise).
test("#196: a caret in a nested callout keeps the columns layout side-by-side and leaks no fences", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "nested-reveal");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\n:::note\nAAA note body\n:::\n:::\n:::column\nBBB\n:::\n::::\n\nbot\n");
  await sleep(900);
  const markers = () => page.evaluate(() => (((document.querySelector("[data-pane=preview] .cm-content") as HTMLElement).innerText).match(/::::?/g) || []).length);
  const layout = () => page.evaluate(() => {
    const cols = Array.from(document.querySelectorAll("[data-pane=preview] .cm-lp-column")) as HTMLElement[];
    const r = cols.map((c) => c.getBoundingClientRect());
    return { n: cols.length, sideBySide: r.length >= 2 && Math.abs(r[0].top - r[1].top) < 20 };
  });

  // caret OUTSIDE the block → everything renders, ZERO raw fence markers, both columns side-by-side.
  await page.getByText("bot").click();
  await sleep(250);
  expect(await markers()).toBe(0);
  expect(await layout()).toEqual({ n: 2, sideBySide: true });
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("AAA note body");

  // Click INTO the nested note → the flex layout is UNCHANGED (2 columns side-by-side), NO fence markers
  // leak. The note is edited via its own editUI (callout panel), not by collapsing the columns to raw.
  await page.getByText("AAA note body").click();
  await sleep(300);
  expect(await markers(), "no container/note fences leak — the layout stays a widget (B(i))").toBe(0);
  expect(await layout(), "columns stay side-by-side with the caret in the nested note").toEqual({ n: 2, sideBySide: true });
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("BBB"); // sibling column rendered
});

// #215 / ADR-100: a nested macro behaves like a top-level macro at depth — clicking it SELECTS it (ring)
// and its edit button opens its OWN editUI island (structured, not the parent's flat source), all while
// the flex layout stays intact; Backspace removes ONLY that macro. Measured in a real browser (the layout
// + island geometry happy-dom can't exercise). This is the "untouchable box" fix (comment 803).
test("#215: a nested callout selects, edits via its own editUI island, and deletes alone — layout intact", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await openScratch(page, "nested-parity");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\n:::note\nAAA note\n:::\n:::\n:::column\nBBB text\n:::\n::::\n\nbot\n");
  await sleep(800);
  const layout = () => page.evaluate(() => {
    const cols = Array.from(document.querySelectorAll("[data-pane=preview] .cm-lp-column")) as HTMLElement[];
    const r = cols.map((c) => c.getBoundingClientRect());
    return { n: cols.length, sideBySide: r.length >= 2 && Math.abs(r[0].top - r[1].top) < 20 };
  });
  await page.getByText("bot").click();
  await sleep(250);

  // (1) Selection: clicking the nested note draws the nested ring + its own edit button (NOT the container).
  await page.getByText("AAA note").click();
  await sleep(300);
  await expect(page.locator("[data-pane=preview] .cm-lp-nested-sel")).toHaveCount(1);
  await expect(page.locator("[data-pane=preview] [data-testid=nested-macro-edit]")).toHaveCount(1);
  expect(await layout(), "layout stays side-by-side while a nested macro is selected").toEqual({ n: 2, sideBySide: true });

  // (2) RichUI: the edit button opens the callout's OWN editUI island (type picker + label + body),
  // in place — the structured macro-unit editor, not the parent columns' flat source dump.
  await page.locator("[data-pane=preview] [data-testid=nested-macro-edit]").first().click({ force: true });
  await sleep(350);
  await expect(page.locator("[data-pane=preview] [data-testid=nested-edit-island]")).toHaveCount(1);
  // #259: the callout type control is a row of VISUAL chips (calloutTypeOption, #174), NOT a bare
  // <select> — the assertion was stale. Check the chip group the callout editUI actually renders.
  await expect(page.locator("[data-pane=preview] [data-testid=nested-edit-island] [data-testid=callout-edit-type]")).toHaveCount(1);
  expect(await layout(), "layout stays side-by-side while the nested editUI island is open").toEqual({ n: 2, sideBySide: true });
  // #265: changing the TYPE via a chip in the nested island must round-trip to the source — the note becomes
  // a warning (a nested callout's type is editable at depth, not just top-level). Was reported as "can't
  // change type" (the assertion above only proved the chips render; this proves they FUNCTION at depth).
  await page.locator("[data-pane=preview] [data-testid=nested-edit-island] [data-testid=callout-edit-type-warning]").click({ force: true });
  await sleep(300);
  await page.keyboard.press("Escape");
  await sleep(300);
  // the nested callout re-rendered as a WARNING (source :::note → :::warning), sibling column intact.
  await expect(page.locator("[data-pane=preview] .cm-lp-column .cm-lp-callout-warning")).toHaveCount(1);
  await expect(page.locator("[data-pane=preview] .cm-lp-column .cm-lp-callout-note")).toHaveCount(0);

  // (4) Deletion: Backspace on the selected nested note removes ONLY it — container + sibling intact.
  await page.getByText("AAA note").click();
  await sleep(250);
  await page.keyboard.press("Backspace");
  await sleep(350);
  const txt = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(txt, "the note is gone").not.toContain("AAA note");
  expect(txt, "the sibling column survives").toContain("BBB text");
  expect(await layout(), "both columns still render side-by-side after the nested delete").toEqual({ n: 2, sideBySide: true });
  expect(errs, errs.join(" | ")).toHaveLength(0);
});

// #265 (review rejection): the earlier #215 assertions used force:true clicks, which bypass the real
// failure — a nested callout's editUI island OPENS but you can't WRITE to it because the outer columns atom
// swallows the input/focus (MacroWidget.ignoreEvent=false). This test drives the island with REAL clicks
// and REAL typing (no force): the body edit and the type-chip change must both take effect at depth. Real
// Chromium — a focus/event-routing concern happy-dom + synthetic force-clicks can't exercise.
test("#265: a nested callout island accepts REAL typing + a REAL type-chip click (input not swallowed)", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await openScratch(page, "nested-real-input");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\n:::note\nAAA note\n:::\n:::\n:::column\nBBB text\n:::\n::::\n\nbot\n");
  await sleep(800);

  // Open the nested note's editUI island via REAL clicks (no force).
  await page.getByText("bot").click();
  await page.getByText("AAA note").click();
  await sleep(300);
  await page.locator("[data-pane=preview] [data-testid=nested-macro-edit]").first().click();
  await sleep(350);
  const island = page.locator("[data-pane=preview] [data-testid=nested-edit-island]");
  await expect(island).toHaveCount(1);

  // (A) REAL typing into the body textarea must land (the swallow bug ate the keystrokes / focus).
  const body = island.locator("[data-testid=callout-edit-body]");
  await body.click(); // real click to focus (the reported bug: this click was swallowed → island torn down)
  await expect(island).toHaveCount(1); // still open after clicking into it (not destroyed by a caret-move)
  await page.keyboard.press("End");
  await page.keyboard.type(" EDITED");
  await expect(body).toHaveValue(/AAA note EDITED/); // the field actually received the keys
  // Blur the body (real click on the label input) → its change fires → commit → source round-trips.
  await island.locator("[data-testid=callout-edit-label]").click();
  await sleep(300);

  // (B) REAL click (no force) on the WARNING type chip → the type changes at depth.
  await page.locator("[data-pane=preview] [data-testid=nested-edit-island] [data-testid=callout-edit-type-warning]").click();
  await sleep(300);

  // Exit the island (click outside) and assert BOTH edits took: the nested callout is a WARNING whose body
  // carries the typed text, and the sibling column is untouched.
  await page.getByText("bot").click();
  await sleep(400);
  await expect(page.locator("[data-pane=preview] .cm-lp-column .cm-lp-callout-warning")).toHaveCount(1);
  await expect(page.locator("[data-pane=preview] .cm-lp-column .cm-lp-callout-note")).toHaveCount(0);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("AAA note EDITED");
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("BBB text");
  expect(errs, errs.join(" | ")).toHaveLength(0);
});

// #174a mermaid diagram AND a GFM pipe table nested inside a tab must render at FULL SIZE once the
// tab activates. Before the fix, mermaid rendered while its panel was display:none (measured 0 width → a
// degenerate sliver), and the nested table had no border/padding CSS (a padless skeleton). The old #174-1/4
// specs only asserted existence, so both regressions passed. This asserts GEOMETRY, on the initially-hidden
// second tab (the worst case).
test("#174nested mermaid + pipe table lay out at full size when a hidden tab activates", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  await openScratch(page, "nested-geom");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(
    "::::tabs\n:::tab[One]\nplain\n:::\n:::tab[Two]\n```mermaid\nflowchart LR\n  Alpha --> Beta --> Gamma --> Delta\n```\n\n| Col A | Col B |\n| --- | --- |\n| one | two |\n:::\n::::\n\nend\n",
  );
  await sleep(1000);
  await page.keyboard.press("Control+End"); // caret out of the macro
  await sleep(300);

  const tabs = page.locator("[data-pane=preview] [data-testid=macro-tabs]");
  await expect(tabs).toHaveCount(1);
  // Activate the SECOND tab — it was display:none, so mermaid first rendered degenerate (the bug).
  await tabs.locator(".cm-lp-tab", { hasText: "Two" }).click();
  await sleep(900); // mermaid async re-render on becoming visible (ResizeObserver)

  const active = tabs.locator(".cm-lp-tabpanel-active");
  // 1: the mermaid SVG lays out at a real width (a hidden-render sliver was ~87px).
  const svgW = await active.locator("[data-testid=macro-mermaid] svg").evaluate((el) => el.getBoundingClientRect().width);
  expect(svgW).toBeGreaterThan(200);
  // 2: the nested pipe table is a real bordered table (width + cell padding), not a padless skeleton.
  const table = active.locator("table.cm-lp-md-table");
  await expect(table).toHaveCount(1);
  const tableW = await table.evaluate((el) => el.getBoundingClientRect().width);
  expect(tableW).toBeGreaterThan(100);
  const cellPad = await table.locator("td").first().evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(cellPad).toBeGreaterThan(0);
});

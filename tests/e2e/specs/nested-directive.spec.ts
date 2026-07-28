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

  // Click INTO the nested note → the SLOT ISLAND opens for that column (#278 A1: one-click slot
  // entry). Fences may show INSIDE the island (it is an editing surface — the note reveals under the
  // caret exactly like top-level); the OUTER surface still leaks nothing, and the row stays side-by-side
  // (the island occupies the clicked cell's flex slot, the sibling column is untouched).
  await page.getByText("AAA note body").click();
  await sleep(500);
  await expect(page.locator("[data-testid=slot-edit-island]"), "one click enters the slot island").toHaveCount(1);
  const outsideMarkers = await page.evaluate(() => {
    const root = (document.querySelector("[data-pane=preview] .cm-content") as HTMLElement).cloneNode(true) as HTMLElement;
    root.querySelector("[data-testid=slot-edit-island]")?.remove();
    return (root.innerText.match(/::::?/g) || []).length;
  });
  expect(outsideMarkers, "no fences leak OUTSIDE the island — the container stays a widget").toBe(0);
  const rowLayout = await page.evaluate(() => {
    const island = document.querySelector("[data-testid=slot-edit-island]") as HTMLElement | null;
    const col = document.querySelector("[data-pane=preview] .cm-lp-column") as HTMLElement | null;
    if (!island || !col) return null;
    return Math.abs(island.getBoundingClientRect().top - col.getBoundingClientRect().top) < 20;
  });
  expect(rowLayout, "the island sits side-by-side with the sibling column").toBe(true);
  expect(await page.locator("[data-pane=preview] .cm-content").first().innerText()).toContain("BBB"); // sibling column rendered
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

  // (1) Entry (#278 A1): clicking the nested note opens the SLOT ISLAND — no nested ring, no direct
  // per-macro affordance; the column's content becomes editable as one live-preview surface.
  await page.getByText("AAA note").click();
  await sleep(500);
  const island = page.locator("[data-testid=slot-edit-island]");
  await expect(island).toHaveCount(1);
  await expect(page.locator("[data-pane=preview] .cm-lp-nested-sel")).toHaveCount(0);

  // (2) RichUI at depth: inside the island the note behaves like TOP-LEVEL — caret on its head line
  // surfaces the entry pill; the pill opens the callout's structured editUI (type chips + label + body).
  // #543: the island now opens with the note RENDERED (a mount-default caret reveals nothing); a REAL
  // click on the rendered note is what reveals its raw source (the #543 parity guard), so click that
  // first, then the revealed head line.
  await island.locator(".cm-content").getByText("AAA note").click();
  await sleep(300);
  await island.locator(".cm-content").getByText(/:::note/).click();
  await sleep(300);
  const pill = island.locator("[data-testid=callout-richui-enter]");
  await expect(pill, "the top-level entry pill exists inside the island").toHaveCount(1);
  const pb = (await pill.boundingBox())!;
  await page.mouse.click(pb.x + pb.width / 2, pb.y + pb.height / 2); // coords: the pill fades/remounts, actionability loops
  await sleep(400);
  await expect(page.locator("[data-testid=callout-edit-type]"), "the callout editUI opened at depth").toHaveCount(1);
  // Changing the TYPE via a chip must round-trip to the source — the note becomes a warning.
  await page.locator("[data-testid=callout-edit-type-warning]").click({ force: true });
  await sleep(300);
  await page.keyboard.press("Escape");
  await sleep(300);
  // Commit the island (click outside) → the nested callout re-renders as a WARNING, sibling intact.
  await page.getByText("bot").click();
  await sleep(500);
  await expect(page.locator("[data-pane=preview] .cm-lp-column .cm-lp-callout-warning")).toHaveCount(1);
  await expect(page.locator("[data-pane=preview] .cm-lp-column .cm-lp-callout-note")).toHaveCount(0);
  expect(await layout(), "layout stays side-by-side after the depth edit").toEqual({ n: 2, sideBySide: true });

  // (4) Deletion at depth: re-enter the island and delete the callout's three source lines — ONLY the
  // note goes; the container and the sibling column survive.
  await page.getByText("AAA note").click();
  await sleep(500);
  await expect(island).toHaveCount(1);
  // #543: rendered-first here too — reveal the warning's raw source with a real click before aiming
  // at its head line.
  await island.locator(".cm-content").getByText("AAA note").click();
  await sleep(300);
  await island.locator(".cm-content").getByText(/:::warning/).click();
  await sleep(200);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Delete");
  await sleep(300);
  await page.getByText("bot").click();
  await sleep(500);
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

  // Open the note's editUI at depth via REAL clicks (no force): one click enters the SLOT island
  // (#278 A1), a click on the note's head line surfaces the entry pill, the pill opens the editUI.
  await page.getByText("bot").click();
  await page.getByText("AAA note").click();
  await sleep(500);
  const slotIsland = page.locator("[data-testid=slot-edit-island]");
  await expect(slotIsland).toHaveCount(1);
  // #543: the island opens with the note RENDERED — reveal it with a real click first.
  await slotIsland.locator(".cm-content").getByText("AAA note").click();
  await sleep(300);
  await slotIsland.locator(".cm-content").getByText(/:::note/).click();
  await sleep(300);
  const pb265 = (await slotIsland.locator("[data-testid=callout-richui-enter]").boundingBox())!;
  await page.mouse.click(pb265.x + pb265.width / 2, pb265.y + pb265.height / 2);
  await sleep(400);
  const island = page.locator("[data-pane=preview] .cm-lp-callout-edit");
  await expect(island).toHaveCount(1);

  // (A) REAL typing into the body textarea must land (the swallow bug ate the keystrokes / focus).
  const body = page.locator("[data-testid=callout-edit-body]");
  await body.click(); // real click to focus (the reported bug: this click was swallowed → island torn down)
  await expect(island).toHaveCount(1); // still open after clicking into it (not destroyed by a caret-move)
  await page.keyboard.press("End");
  await page.keyboard.type(" EDITED");
  // #456 S5: the body is a host CM SURFACE now, not a textarea — assert its text, not a value.
  await expect(body).toContainText(/AAA note EDITED/); // the field actually received the keys
  // Blur the body (real click on the label input) → its change fires → commit → source round-trips.
  await page.locator("[data-testid=callout-edit-label]").click();
  await sleep(300);

  // (B) REAL click (no force) on the WARNING type chip → the type changes at depth.
  await page.locator("[data-testid=callout-edit-type-warning]").click();
  await sleep(300);
  await page.keyboard.press("Escape"); // exit the editUI back to the island
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

// #174 a mermaid diagram AND a GFM pipe table nested inside a tab must render at FULL SIZE once the
// tab activates. Before the fix, mermaid rendered while its panel was display:none (measured 0 width → a
// degenerate sliver), and the nested table had no border/padding CSS (a padless skeleton). The old #174-1/4
// specs only asserted existence, so both regressions passed. This asserts GEOMETRY, on the initially-hidden
// second tab (the worst case).
test("#174 nested mermaid + pipe table lay out at full size when a hidden tab activates", async ({ browser }) => {
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

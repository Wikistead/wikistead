import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #185 / ADR-096 (Option B): a nested `::::tabs > :::tab > ::::columns > :::column` used to have its
// parent `:::tabs` EARLY-CLOSED by the inner `::::columns` close (lezer's `>=` colon match), which
// orphaned the second tab and leaked it (as a plain paragraph) OUTSIDE the tabs frame. comment 781: the
// resolver fixed the range LAYER (motion/reveal/fence-hide) but the tabs WIDGET body was still sliced
// from lezer's `node.to`, so the widget only split the first tab and the rest leaked. Driving the widget
// range from the resolver (directiveMacroAt) + skipping the orphaned sibling nodes fixes it. This test
// asserts the WIDGET STRUCTURE (both tab buttons, both columns, tab switching), not just marker leak —
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

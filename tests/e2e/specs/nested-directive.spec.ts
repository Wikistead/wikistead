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

// #196 / ADR-092 (comment 740): innermost-wins reveal. With the caret inside a NESTED callout, only that
// callout reveals raw — the OUTER container's own fences (::::columns / :::column / ::::) must NOT leak,
// and the sibling column stays rendered. Measured in a real browser (the reveal + resolver fence-hide are
// geometry/decoration concerns happy-dom can't exercise). Guards the leak the reviewer reproduced.
test("#196: a nested callout reveals raw without leaking the container's fences", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "nested-reveal");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\n:::note\nAAA note body\n:::\n:::\n:::column\nBBB\n:::\n::::\n\nbot\n");
  await sleep(900);
  const markers = () => page.evaluate(() => (((document.querySelector("[data-pane=preview] .cm-content") as HTMLElement).innerText).match(/::::?/g) || []).length);

  // caret OUTSIDE the block → everything renders, ZERO raw fence markers, both columns' content shown.
  await page.getByText("bot").click();
  await sleep(250);
  expect(await markers()).toBe(0);
  const cleanText = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(cleanText).toContain("BBB"); // sibling column rendered
  expect(cleanText).toContain("AAA note body");

  // navigate the caret INTO the nested note → ONLY the note's own two fences (:::note / :::) reveal; the
  // container's ::::columns / :::column / :::: are hidden (so the count is 2, not the whole structure).
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await sleep(250);
  expect(await markers(), "only the innermost note's own fences reveal; the container's must stay hidden").toBe(2);
  const editingText = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(editingText).not.toContain("::::columns"); // the container's opening fence must NOT leak
  expect(editingText).not.toContain("::::");        // nor its closing fence
  expect(editingText).toContain(":::note");          // the innermost note IS raw (being edited)
  expect(editingText).toContain("BBB");              // the sibling column stays rendered
});

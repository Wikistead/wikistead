import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #185 / ADR-096 (Option B): a nested `::::tabs > :::tab > ::::columns > :::column` used to have its
// parent `:::tabs` EARLY-CLOSED by the inner `::::columns` close (lezer's `>=` colon match), which
// orphaned the second tab and leaked raw `:::`/`::::` markers. resolveDirectiveRanges (stack-based,
// Pandoc semantics) + the resolver-driven fence hide (sub-task 2b) fix it. Verified in a real browser
// (happy-dom can't lay this out); guards against the early-close regressing.
test("#185: nested tabs>columns renders clean — no raw ::: marker leak, no CM errors", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openScratch(page, "nested-dir");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(
    "intro\n\n::::tabs\n:::tab[T1]\n::::columns\n:::column\nAAA\n:::\n:::column\nBBB\n:::\n::::\n:::\n:::tab[T2]\nCCC\n:::\n::::\n\noutro\n",
  );
  await sleep(900);
  await page.keyboard.press("Control+End"); // caret OUT of the macro (reveal-on-cursor would show raw otherwise)
  await sleep(300);
  const text = await page.locator("[data-pane=preview] .cm-content").innerText();
  // No raw directive markers leak when the caret is outside the block.
  expect(text, "raw ::: / :::: markers leaked").not.toMatch(/:::/);
  // The parent tabs was NOT early-closed: both tabs' content + the nested columns render.
  expect(text).toContain("AAA");
  expect(text).toContain("BBB");
  expect(text).toContain("CCC");
  // The surrounding paragraphs are intact (nothing was truncated by the early close).
  expect(text).toContain("intro");
  expect(text).toContain("outro");
  // No CM overlapping-decoration / render errors from the fence-hide post-pass.
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

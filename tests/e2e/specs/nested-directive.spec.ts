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

import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M1 slice 2 (ADR-022): the ::: container directive path via the in-house lezer parser.
// A :::callout renders as a styled box whose content stays live-preview Markdown (the
// **bold** inside is decorated), the ::: fence lines are hidden (reveal-on-cursor), and
// the source round-trips (the ::: stays plain text in the canonical Y.Text).
//
// REAL throwaway page so the transient presence caret can't ghost other demo specs.
test(":::callout directive: styled box, nested markdown, hide-fence + round-trip", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  // A callout with bold content, then a line below so the caret ends off the block.
  for (const line of [":::callout", "Heads up **bold** inside.", ":::", "", "below the callout"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);

  // The box renders (containerClass on the directive's lines).
  const box = page.locator("[data-pane=preview] .cm-lp-callout").first();
  await expect(box).toBeVisible();
  // Content stays Markdown: the **bold** is decorated (cm-lp-strong), proving nested
  // parsing — not an opaque widget.
  await expect(page.locator("[data-pane=preview] .cm-lp-strong")).toContainText("bold");
  // The ::: fence markers are hidden (not shown as literal text) while the caret is off
  // the block.
  const visible = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(visible).toContain("Heads up");
  expect(visible).not.toContain(":::callout");

  // Round-trip: caret onto the opening fence line reveals the raw ::: (offset-invariant
  // — the canonical source always had the directive text).
  await box.click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  await sleep(250);
  const revealed = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(revealed).toContain(":::callout");
});

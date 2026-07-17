import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #358: in WYSIWYG, reveal-only macros (details etc.) had NO edit path — #164's "wysiwyg never
// reveals" rule suppressed the AUTOMATIC caret-in reveal AND (the bug) the EXPLICIT entry too:
// Ctrl+Enter dispatched macroRenderActiveField but the reveal predicates ignored it. The fix splits
// the rule: automatic reveal stays suppressed (the #164 invariant), explicit entry (Ctrl+Enter / ✎)
// reveals the covered block in every editable mode. Esc exits back to the rendered form. Real Chromium.
test("#358: WYSIWYG — Ctrl+Enter reveals a details block for editing; auto caret-in does not; Esc restores", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "wys-entry-358");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More]\nhidden body\n:::\n\nafter\n");
  await sleep(400);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(400);

  // rendered as the summary bar; the raw ::: syntax is hidden (WYSIWYG)
  const bar = page.getByTestId("details-summary-bar");
  await expect(bar).toBeVisible();
  let raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw).not.toContain(":::details");

  // #164 non-regression: NAVIGATING the caret onto the block must NOT auto-reveal in WYSIWYG.
  await page.click("[data-pane=preview] .cm-content"); // caret into the doc (lands after the block)
  await page.keyboard.press("Control+Home");           // caret to doc start = onto the details atom
  await sleep(300);
  raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw).not.toContain(":::details"); // still the widget — automatic reveal stays suppressed
  await expect(page.getByTestId("details-summary-bar")).toBeVisible();

  // EXPLICIT entry (#358 → #425/ADR-168 migrated): Ctrl+Enter opens the PANEL editUI — never raw
  // `:::` (Source mode is the raw path now).
  await page.keyboard.press("Control+Enter");
  await sleep(400);
  await expect(page.getByTestId("details-editui")).toBeVisible({ timeout: 5000 });
  raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw, "no raw fences while editing").not.toContain(":::details");
  await expect(page.getByTestId("details-summary-bar")).toHaveCount(0);

  // Esc exits the panel → the rendered widget returns.
  await page.keyboard.press("Escape");
  await sleep(400);
  raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw).not.toContain(":::details");
  await expect(page.getByTestId("details-summary-bar")).toBeVisible();
});

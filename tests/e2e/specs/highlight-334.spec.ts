import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #334 / ADR-129: highlight (`==text==`) in the CM6 editor live-preview (the third surface — the unit
// tests cover the browser + server-export renderers). Caret away → the `==` delimiters hide and the run
// styles as .cm-lp-highlight; caret on the line → the raw `==` reveals (strikethrough parity).
test(":::highlight `==text==` styles a mark and hides the `==` when the caret is away", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "hl");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("before ==foo== after\n\nsecond line\n");
  await sleep(300);
  // Move the caret to the last line so the highlight line has no selection → delimiters hidden.
  await page.keyboard.press("Control+End");
  await sleep(300);

  const mark = page.locator("[data-pane=preview] .cm-lp-highlight").first();
  await expect(mark).toHaveText("foo");
  const shown = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(shown).toContain("before foo after"); // `==` delimiters hidden around the styled run
  expect(shown).not.toContain("==foo=="); // raw delimiters not shown when the caret is away
});

// #334 review (comment 1519): the reported failure — `==` mixed with **bold** left the `==` literal.
// Real Chromium: `word==**bold**==word` (no surrounding spaces) must highlight AND hide the `==`.
test("#334: highlight opens next to bold with no surrounding spaces (word==**bold**==word)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "hl-bold");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("前後あり==**太字**==つづき\n\nsecond line\n");
  await sleep(300);
  await page.keyboard.press("Control+End"); // caret away from the highlight line
  await sleep(300);

  // The editor styles marks as classed spans (.cm-lp-highlight / .cm-lp-strong), not <mark>/<strong> elements.
  const mark = page.locator("[data-pane=preview] .cm-lp-highlight").first();
  await expect(mark).toBeVisible();
  await expect(mark).toContainText("太字"); // the highlighted run holds the bold text
  expect(await page.locator("[data-pane=preview] .cm-lp-strong").count(), "the bold is still styled inside").toBeGreaterThan(0);
  const shown = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(shown).toContain("前後あり太字つづき"); // `==` hidden, bold rendered
  expect(shown).not.toContain("=="); // the raw `==` no longer leaks (the reported bug)
});

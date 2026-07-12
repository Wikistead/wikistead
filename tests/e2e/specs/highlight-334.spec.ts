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

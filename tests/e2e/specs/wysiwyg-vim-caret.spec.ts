import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #240: in WYSIWYG + vim, the block ("fat") cursor must NEVER paint a hidden syntax glyph (a link's
// [ ]( ) or a **/` mark), and vim h/l must step by VISIBLE char. Real Chromium (the fat cursor is a
// separate render layer that reads the raw doc char — synthetic DOM can't reproduce it).
test("#240: vim normal fat cursor never shows a hidden syntax char in WYSIWYG", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "wys-vim-caret");
  await enterEdit(page);
  // turn vim ON
  await page.getByTestId("vim-toggle").click().catch(async () => {
    await page.locator("[data-testid=vim-toggle], [aria-label*=vim i]").first().click();
  });
  await sleep(200);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("i"); // insert mode to type
  await page.keyboard.type("x [hoge](https://ex.test/pq) y");
  await page.keyboard.press("Escape"); // back to normal
  await sleep(200);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(400);
  // go to end of line, then walk left with h, asserting the fat cursor letter is always visible text
  await page.keyboard.press("Escape");
  await page.keyboard.type("$");
  await sleep(150);
  const fatLetter = () => page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-fat-cursor");
    return el ? (el.textContent ?? "") : "__none__";
  });
  const hiddenChars = new Set(["[", "]", "(", ")", "*", "`", "|", ":"]);
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    const l = await fatLetter();
    seen.push(l);
    expect(hiddenChars.has(l.trim()), `fat cursor painted a hidden syntax char "${l}" (step ${i}); trail=${JSON.stringify(seen)}`).toBe(false);
    await page.keyboard.type("h");
    await sleep(80);
  }
});

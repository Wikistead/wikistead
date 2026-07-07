import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #240: in WYSIWYG, arrow motion must step by VISIBLE character — hidden syntax markers (a link's
// [ ]( ) and its URL, or bold/italic marks) must NOT cost phantom presses. Measured by counting the
// distinct caret doc-offsets (window.__lpSel.head) visited crossing a line vs. its visible length.
async function pressesToCross(page: any): Promise<number[]> {
  await page.locator("[data-pane=preview] .cm-line").first().click({ force: true });
  await page.keyboard.press("Home");
  await sleep(120);
  const head = () => page.evaluate(() => (window as any).__lpSel?.head ?? -1);
  const heads: number[] = [await head()];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("ArrowRight");
    const h = await head();
    if (h === heads[heads.length - 1]) break; // reached end of line
    heads.push(h);
  }
  return heads;
}

test("#240: WYSIWYG arrow crosses a link line by visible char (no phantom presses)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "wys-motion");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("x [hoge](https://ex.test/pq) y"); // visible "x hoge y" = 8 chars
  await sleep(300);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(400);
  const heads = await pressesToCross(page);
  // 8 visible chars → 9 distinct caret stops (0..8), i.e. 8 presses. Allow ±1.
  expect(heads.length).toBeGreaterThanOrEqual(8);
  expect(heads.length).toBeLessThanOrEqual(10);
});

test("#240: WYSIWYG arrow crosses bold/italic marks by visible char", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "wys-motion-bold");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("a **bold** b"); // visible "a bold b" = 8 chars
  await sleep(300);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(400);
  const heads = await pressesToCross(page);
  expect(heads.length).toBeGreaterThanOrEqual(8);
  expect(heads.length).toBeLessThanOrEqual(10);
});

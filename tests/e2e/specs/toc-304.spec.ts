import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #304: the member editor's TOC rail scroll-spy. (1) A jumped-to heading must light even under a TALL (2-line)
// title band — the old sampler used a fixed 48px offset, so with a taller band the sample point sat ABOVE the
// landed heading and the PREVIOUS item lit. (2) At the very bottom, a short final section never reaches the
// sampler, so the last item must be clamped active. (4) The rail grows into the right whitespace (was a fixed
// 210px). Real Chromium, wide viewport, a deliberately LONG page title to force a 2-line band.
const LONG_TITLE = "A deliberately very long page title that wraps onto two lines in the frosted header band";

test("#304: TOC jump lights the CLICKED heading under a 2-line band; bottom clamps the last; rail is elastic", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 720 } })).newPage();
  await openScratch(page, LONG_TITLE);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  const filler = (n: string) => Array.from({ length: 20 }, (_, i) => `${n} paragraph ${i} lorem ipsum dolor sit amet consectetur.`).join("\n\n");
  await page.keyboard.insertText(
    `# Alpha Heading\n\n${filler("A")}\n\n# Bravo Heading\n\n${filler("B")}\n\n# Charlie Heading\n\n${filler("C")}\n\n# Delta Heading\n\nshort tail\n`,
  );
  await sleep(600);

  // the band wrapped to (at least) 2 lines → taller than the old fixed 48px sample offset.
  const bandH = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".cm-content")!).paddingTop) || 0);
  expect(bandH, `band height ${bandH} should exceed the old 48px sampler`).toBeGreaterThan(48);

  const rail = page.locator("[data-testid=toc][data-variant=rail]");
  await expect(rail).toBeVisible({ timeout: 8000 });
  const items = rail.getByTestId("toc-item");
  await expect(items).toHaveCount(4);

  // (4) elastic width — grows past the old fixed 210px in the wide right whitespace.
  const railW = await rail.evaluate((el) => el.getBoundingClientRect().width);
  expect(railW, `rail width ${railW} should exceed the old fixed 210px`).toBeGreaterThan(210);

  // (1) click "Charlie" → THE CLICKED item lights (not Bravo, the old off-by-one under a tall band).
  await items.nth(2).click();
  await sleep(500);
  await expect(items.nth(2)).toHaveAttribute("data-active", "");
  await expect(items.nth(1)).not.toHaveAttribute("data-active", "");

  // (2) scroll to the very bottom → the short final section ("Delta") is clamped active.
  await page.locator(".cm-scroller").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await sleep(400);
  await expect(items.nth(3)).toHaveAttribute("data-active", "");
});

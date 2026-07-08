import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #255: a rendered diagram fence (mermaid/plantuml/excalidraw) is CENTRED by default, and the fence
// `align=` attribute pushes it left/right (center writes no attribute). Real Chromium — the alignment is
// column-flex on the macro wrap.
test("#255: a diagram fence is centered by default; align=left/right overrides via the fence attr", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "macro-align");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // three mermaid fences: default (center), align=left, align=right.
  await page.keyboard.insertText(
    "```mermaid\ngraph TD; A-->B\n```\n\n```mermaid align=left\ngraph TD; C-->D\n```\n\n```mermaid align=right\ngraph TD; E-->F\n```\n\nbelow\n",
  );
  await sleep(700);
  // caret off the macros so nothing is revealed/selected.
  await page.getByText("below").click();
  await sleep(300);

  const wraps = page.locator("[data-pane=preview] .cm-lp-macro-wrap");
  await expect(wraps).toHaveCount(3);
  // default → center; the alignment is column flex on the wrap.
  await expect(wraps.nth(0)).toHaveClass(/cm-lp-align-center/);
  expect(await wraps.nth(0).evaluate((el) => getComputedStyle(el).alignItems)).toBe("center");
  // align=left / align=right honoured from the fence attribute.
  await expect(wraps.nth(1)).toHaveClass(/cm-lp-align-left/);
  expect(await wraps.nth(1).evaluate((el) => getComputedStyle(el).alignItems)).toBe("flex-start");
  await expect(wraps.nth(2)).toHaveClass(/cm-lp-align-right/);
  expect(await wraps.nth(2).evaluate((el) => getComputedStyle(el).alignItems)).toBe("flex-end");
});

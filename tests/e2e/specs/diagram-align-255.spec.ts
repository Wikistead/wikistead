import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #255 Slice 2: a rendered diagram macro (mermaid) is centred by default and its alignment can be changed
// to left/right. The RIGHT-CLICK context menu is the robust path (the ✎-adjacent hover button is the
// convenience — see needs-human-check). Changing align rewrites the fence `align=` attribute, reflected in
// the widget's cm-lp-align-* class (the #255updateDOM fix swaps the align class IN PLACE on an
// align-only change — no rebuild, so the rendered SVG/img isn't re-resolved async).
test("#255: right-click a diagram macro → Align left rewrites the fence align (widget reflows left)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "align-255");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```mermaid\ngraph TD\nA-->B\n```\n\nbelow\n");
  await sleep(600);

  const wrap = () => page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await expect(wrap()).toBeVisible();
  await expect(wrap()).toHaveClass(/cm-lp-align-center/); // default center (no attribute written)

  // Right-click the rendered widget → the context menu offers alignment → Align left reflows it left.
  await wrap().click({ button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("ctx-item-align-left").click();
  await expect(wrap()).toHaveClass(/cm-lp-align-left/, { timeout: 8000 });
});

// #255changing a diagram's alignment must NOT jump the scroll position. The bug: an align-only
// change rebuilt the widget, which re-rendered the mermaid SVG async — its height collapsed to 0 while it
// reloaded, the doc shrank, and CM lost its scroll (jumped to top). The fix applies the align class in place
// (updateDOM), keeping the rendered SVG, so scrollTop holds.
test("#255changing a diagram's alignment does not jump the scroll position", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 600 } })).newPage();
  await openScratch(page, "align-scroll-255");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  const above = Array.from({ length: 25 }, (_, i) => `above ${i}`).join("\n");
  const below = Array.from({ length: 40 }, (_, i) => `below ${i}`).join("\n");
  await page.keyboard.insertText(`${above}\n\n\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\`\n\n${below}\n`);
  await sleep(700);

  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await wrap.scrollIntoViewIfNeeded(); // scroll down so the diagram is in view (content above → scrollTop > 0)
  await sleep(200);
  const scroller = page.locator("[data-pane=preview] .cm-scroller");
  const before = await scroller.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(100); // we ARE scrolled down (a jump-to-top would be a large delta)

  await wrap.click({ button: "right" });
  await page.getByTestId("ctx-item-align-left").click();
  await expect(wrap).toHaveClass(/cm-lp-align-left/, { timeout: 8000 });
  await sleep(400); // let any (unwanted) async reflow settle
  const after = await scroller.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(40); // scroll held — no collapse/jump
});

import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #255 Slice 2: a rendered diagram macro (mermaid) is centred by default and its alignment can be changed
// to left/right. The RIGHT-CLICK context menu is the robust path (the ✎-adjacent hover button is the
// convenience — see needs-human-check). Changing align rewrites the fence `align=` attribute, reflected in
// the widget's cm-lp-align-* class (the #255 updateDOM fix rebuilds the widget on an align-only change).
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

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

// #255 comment 1040: the top-left ✎ edit and align toggle share ONE flex row (cm-lp-macro-btnrow), so the
// #174 "Ctrl+↵" hint that widens the ✎ can never make the align button overlap it. Real Chromium.
test("#255: the ✎ and align buttons flow in one row and never overlap", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "macro-btnrow");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```mermaid\ngraph TD; A-->B\n```\n\nbelow\n");
  await sleep(700);
  await page.getByText("below").click();
  await sleep(300);

  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await wrap.hover(); // reveal the hover-gated buttons
  const edit = wrap.getByTestId("macro-edit");
  const align = wrap.getByTestId("macro-align");
  await expect(edit).toBeVisible();
  await expect(align).toBeVisible();
  // both live inside the single flex row.
  await expect(wrap.locator(".cm-lp-macro-btnrow [data-testid=macro-edit]")).toHaveCount(1);
  await expect(wrap.locator(".cm-lp-macro-btnrow [data-testid=macro-align]")).toHaveCount(1);
  // geometry: align sits entirely to the RIGHT of the ✎ (no horizontal overlap).
  const e = (await edit.boundingBox())!;
  const a = (await align.boundingBox())!;
  expect(a.x).toBeGreaterThanOrEqual(e.x + e.width - 1); // align.left ≥ edit.right → disjoint
});

// #255the align control is a 3-button SEGMENT (left | center | right), not a single cycling button.
// The active side is highlighted; clicking a side picks it DIRECTLY (no cycle).
test("#255the align control is a 3-segment control; the active side is highlighted, a click picks it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "align-seg");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```mermaid\ngraph TD; A-->B\n```\n\nbelow\n");
  await sleep(700);
  await page.getByText("below").click();
  await sleep(300);
  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await wrap.hover();

  // three distinct side buttons; CENTER is active by default (the diagram default, #255).
  await expect(wrap.getByTestId("macro-align-left")).toBeVisible();
  await expect(wrap.getByTestId("macro-align-center")).toBeVisible();
  await expect(wrap.getByTestId("macro-align-right")).toBeVisible();
  await expect(wrap.getByTestId("macro-align-center")).toHaveAttribute("aria-pressed", "true");
  await expect(wrap.getByTestId("macro-align-right")).toHaveAttribute("aria-pressed", "false");

  // clicking RIGHT picks it directly (not a cycle): the wrap aligns right and the right side lights up.
  await wrap.getByTestId("macro-align-right").click({ force: true });
  await sleep(200);
  await expect(wrap).toHaveClass(/cm-lp-align-right/);
  await expect(wrap.getByTestId("macro-align-right")).toHaveAttribute("aria-pressed", "true");
  await expect(wrap.getByTestId("macro-align-center")).toHaveAttribute("aria-pressed", "false");
});

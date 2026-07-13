import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #360: mermaid is a singleton whose theme is fixed by initialize(). It used to be initialized ONCE at first
// load, so a mid-session light/dark switch left diagrams rendered in the ORIGINAL theme even though the widget
// rebuilt (MacroWidget.eq keys on theme, #200) and the #352 cache re-rendered for the new key. loadMermaid now
// re-initializes when the theme changes, so the diagram follows. Real Chromium: render a diagram, read a node's
// computed fill, toggle the theme, and assert the fill actually changes (the diagram re-themed).
const nodeFill = (page: import("@playwright/test").Page) =>
  page
    .locator("[data-pane=preview] [data-testid=macro-mermaid] svg .node rect, [data-pane=preview] [data-testid=macro-mermaid] svg rect")
    .first()
    .evaluate((el) => getComputedStyle(el as Element).fill);

test("#360: a rendered mermaid diagram follows a mid-session theme switch", async ({ page }) => {
  await openScratch(page, "mermaid-theme");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```\n");
  await page.keyboard.press("Control+Home"); // caret to the "top" line (OUTSIDE the fence) → the diagram renders as an atom
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").first()).toBeVisible({ timeout: 15000 });
  await sleep(400);
  const lightFill = await nodeFill(page);
  expect(lightFill).toBeTruthy();

  // Switch to dark.
  await page.click("[data-testid=theme-toggle]");
  await page.locator("[data-testid=theme-menu]").getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // The diagram re-renders under the dark theme → the node fill changes. Poll (the re-render is async).
  await expect
    .poll(async () => nodeFill(page), { timeout: 15000, intervals: [400, 600, 800, 1000] })
    .not.toBe(lightFill);
});

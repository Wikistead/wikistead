import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #340: when the caret LEAVES a revealed diagram onto the line below, the block re-mounts as an atom whose
// SVG renders ASYNC and settles TALLER. The #243re-anchor kept the caret in the VIEWPORT, but the
// DRAWN caret (.cm-cursor-primary) was measured before the widget grew, so it stayed frozen at the widget's
// old top — visually INSIDE the figure — while its doc position (the line below) was correct. This asserts
// the stronger property the #243 anti-test missed: after the settle, the drawn caret sits at/below the
// widget's bottom (on its real line), not inside the diagram. A tall viewport so scroll is a no-op and this
// isolates the drawn-position follow (not the scroll).
test("#340: after an async re-render on source-exit, the drawn caret follows below the widget", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 900, height: 1000 } })).newPage();
  await openScratch(page, "exit-caret-340");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  const chain = Array.from({ length: 10 }, (_, i) => `  N${i} --> N${i + 1}`).join("\n");
  await page.keyboard.insertText(`top\n\`\`\`mermaid\nflowchart TD\n${chain}\n\`\`\`\nBELOWLINE\ntail\n`);
  await sleep(1500);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();

  // Reveal the raw source, then place the caret on the line directly BELOW the fence (the transition arms the
  // re-anchor settle window). The SVG then re-renders tall a beat later.
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").click();
  await sleep(300);
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").count()).toBe(0);
  await page.getByText("BELOWLINE", { exact: true }).click();
  await sleep(1800); // async mermaid render + height settle + the re-anchor within the window

  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();
  const geom = await page.evaluate(() => {
    const c = document.querySelector("[data-pane=preview] .cm-cursor-primary") as HTMLElement | null;
    const w = document.querySelector("[data-pane=preview] [data-testid=macro-mermaid]") as HTMLElement | null;
    if (!c || !w) return null;
    return { caretTop: c.getBoundingClientRect().top, widgetTop: w.getBoundingClientRect().top, widgetBottom: w.getBoundingClientRect().bottom };
  });
  expect(geom, "no primary cursor / widget rect").not.toBeNull();
  // The drawn caret must sit at/below the widget's bottom — NOT frozen inside the tall figure (#340).
  expect(
    geom!.caretTop,
    `drawn caret top ${geom!.caretTop} must be >= widget bottom ${geom!.widgetBottom} (was stuck inside the figure at ~${geom!.widgetTop})`,
  ).toBeGreaterThanOrEqual(geom!.widgetBottom - 2);
});

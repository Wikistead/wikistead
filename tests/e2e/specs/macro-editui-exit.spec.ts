import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #239: a fence macro's inline editUI (mermaid/plantuml — a plain textarea with no exit of its own)
// was a TRAP: opening it via ✎ mounted the editor but there was NO way back to the rendered diagram
// (the widget's ignoreEvent()=true swallows Escape before the editor-level handler runs). The host now
// wires an exit (Escape + a Done button) that commits (blur→change→save) and re-renders the macro.
async function openMermaidEditUI(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```mermaid\nflowchart TD\n  A --> B\n```\n\nbelow\n");
  await sleep(500);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").hover();
  await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=macro-edit]").first().click({ force: true });
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]")).toBeVisible();
}

test("#239: Escape exits the mermaid editUI back to the rendered diagram (and commits the edit)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "editui-esc");
  await enterEdit(page);
  await openMermaidEditUI(page);
  await page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("flowchart TD\n  X --> Y");
  await sleep(200);
  await page.keyboard.press("Escape");
  await sleep(600);
  // back to the rendered widget, textarea gone
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();
  expect(await page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]").count()).toBe(0);
  // the edit committed to the doc (read raw via Source)
  await page.getByTestId("displaymode-source").click();
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("X --> Y");
});

test("#239: the Done button exits the editUI back to the rendered diagram", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "editui-done");
  await enterEdit(page);
  await openMermaidEditUI(page);
  await expect(page.locator("[data-pane=preview] [data-testid=editui-done]")).toBeVisible();
  await page.locator("[data-pane=preview] [data-testid=editui-done]").click({ force: true });
  await sleep(600);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();
  expect(await page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]").count()).toBe(0);
});

// #282: typing in the mermaid editUI must not COLLAPSE the live preview pane (the "right half flickers").
// A mid-typing invalid diagram used to shrink the preview to a 1-line error and bounce back, flashing the
// pane and toggling the scrollbar. Fix: hold the pane's height (min-height) during the async re-render +
// debounce the render. The height collapse IS measurable headless; the scrollbar flash itself needs a
// classic (space-taking) scrollbar which headless lacks (see the ticket) → that stays a human check.
test("#282: the mermaid editUI preview holds its height while typing an invalid diagram (no collapse)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "editui-282");
  await enterEdit(page);
  await openMermaidEditUI(page);
  const preview = page.locator("[data-pane=preview] [data-testid=mermaid-edit-preview]");
  await sleep(500); // the initial valid diagram renders → a real preview height
  const h0 = await preview.evaluate((el) => el.getBoundingClientRect().height);
  expect(h0).toBeGreaterThan(40); // a rendered SVG, not collapsed

  // Replace the source with text mermaid can't parse — the debounced render fails …
  await page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("this is definitely not a valid mermaid diagram");
  await sleep(500); // > debounce (150ms) + render
  const h1 = await preview.evaluate((el) => el.getBoundingClientRect().height);
  // … but the pane HELD its height (min-height) instead of collapsing to the 1-line error.
  expect(h1).toBeGreaterThanOrEqual(h0 - 8);
});

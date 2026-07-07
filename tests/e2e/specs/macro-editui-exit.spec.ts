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

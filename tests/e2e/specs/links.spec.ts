import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// Rendered links are click-to-open in the VIEW surface; in the EDIT surface a plain
// click must still place the cursor (→ reveal raw markdown), never navigate. We stub
// window.open to capture the destination deterministically (no real popup/network).
test("rendered links: view click opens, edit click does not", async ({ page }) => {
  await openDemo(page);
  await page.getByTestId("new-page").click();
  await page.waitForURL(/\/p\/.+edit=1/);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(300);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("see [example](https://example.com/x) here");

  // publish → auto-returns to the rendered view
  await expect(page.getByTestId("publish-page")).toBeEnabled();
  await page.getByTestId("publish-page").click();
  await expect(page.getByTestId("edit-toggle")).toBeVisible({ timeout: 8000 });

  // view: the link renders as its text ('[ ]( )' hidden) and carries the sanitized href
  const viewLink = page.locator("[data-pane=preview] .cm-lp-link[data-href]");
  await expect(viewLink).toHaveText("example");
  await page.evaluate(() => { (window as Window & { __opened?: string[] }).__opened = []; window.open = ((u: string) => { (window as Window & { __opened?: string[] }).__opened!.push(u); return null; }) as typeof window.open; });
  await viewLink.click();
  expect(await page.evaluate(() => (window as Window & { __opened?: string[] }).__opened)).toEqual(["https://example.com/x"]);

  // edit: a plain click must NOT navigate (it places the cursor → reveal raw)
  await page.click("[data-testid=edit-toggle]");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.evaluate(() => { (window as Window & { __opened?: string[] }).__opened = []; window.open = ((u: string) => { (window as Window & { __opened?: string[] }).__opened!.push(u); return null; }) as typeof window.open; });
  await page.locator("[data-pane=preview] .cm-lp-link[data-href]").first().click();
  expect(await page.evaluate(() => (window as Window & { __opened?: string[] }).__opened!.length)).toBe(0);
});

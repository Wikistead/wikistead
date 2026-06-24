import { test, expect } from "@playwright/test";
import { openDemo, openScratch, enterEdit, sleep } from "../helpers";

const content = (p: import("@playwright/test").Page) => p.locator("[data-pane=preview] .cm-content").innerText();

// M0-4 (ADR-018): the right-click context menu — the mouse superset. On a selection it
// offers decoration (A) + clipboard + clear-format; on a link, edit-link; with no
// selection, paste + "Insert…" (→ the `/` palette). Editable surface only; view /
// read-only keeps the native menu.
test("right-click on a selection: decoration + clipboard + clear-format; bold applies", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openScratch(page, "ctx-sel");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("hello world");

  // select "hello"
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");

  await page.click("[data-pane=preview] .cm-content", { button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  // shared layer-A decoration items + clipboard + clear-format
  for (const id of ["bold", "italic", "strike", "code", "link", "copy", "cut", "paste", "clearformat"]) {
    await expect(page.getByTestId(`ctx-item-${id}`)).toBeVisible();
  }
  // clicking bold wraps the selection (same command as the bubble) and closes the menu
  await page.getByTestId("ctx-item-bold").click();
  await sleep(150);
  await expect(menu).toHaveCount(0);
  expect(await content(page)).toContain("**hello**");
});

test("right-click with no selection: paste + Insert… (opens the / palette); Esc dismisses", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openScratch(page, "ctx-plain");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("abc");
  await page.keyboard.press("Home"); // caret at line start, no selection, not on a link

  await page.click("[data-pane=preview] .cm-content", { button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible();
  await expect(page.getByTestId("ctx-item-insert")).toBeVisible();
  await expect(page.getByTestId("ctx-item-paste")).toBeVisible();
  // no decoration items in the no-selection menu
  expect(await page.getByTestId("ctx-item-bold").count()).toBe(0);

  // Esc dismisses
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("context-menu")).toHaveCount(0);

  // re-open and use Insert… → the slash palette opens (caret was at line start)
  await page.click("[data-pane=preview] .cm-content", { button: "right" });
  await page.getByTestId("ctx-item-insert").click();
  await expect(page.getByTestId("slash-palette")).toBeVisible();
});

test("right-click on a link offers Edit link (selects the URL, revealing raw)", async ({ page }) => {
  await openScratch(page, "ctx-link");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("[site](http://example.com)");
  await page.keyboard.press("Enter"); // caret moves to a new line so the link line renders
  await sleep(150);
  const link = page.locator("[data-pane=preview] .cm-lp-link").first();
  await expect(link).toBeVisible();

  await link.click({ button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible();
  const edit = page.getByTestId("ctx-item-editlink");
  await expect(edit).toBeVisible();
  await edit.click();
  await sleep(150);
  // the URL is now selected (non-empty selection over the destination)
  const sel = await page.evaluate(() => {
    const s = (window as Window & { __lpSel?: { from: number; to: number } }).__lpSel;
    return s ? s.to - s.from : 0;
  });
  expect(sel).toBeGreaterThan(0);
});

test("view (read-only) surface keeps the native menu — our menu does not appear", async ({ page }) => {
  await openDemo(page); // rendered (read-only) surface, not editing
  await page.click("[data-pane=preview] .cm-content", { button: "right" });
  await sleep(150);
  expect(await page.getByTestId("context-menu").count()).toBe(0);
});

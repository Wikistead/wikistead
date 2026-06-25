import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

const head = (p: any) => p.evaluate(() => (window as any).__lpHeadLine);

// Fix #1 (ADR-017/018): a macro is insertable from the `/` palette by virtue of its
// registration — `/excalidraw` inserts the fence.
test("slash palette inserts a macro (excalidraw) from its registration", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "slashmacro");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/excalidraw");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  expect(await page.locator("[data-testid=slash-palette] .lp-palette-row").count()).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  await sleep(150);
  // Caret to the fence's opening line so the ``` markers reveal (per-line), confirming a
  // ```excalidraw fence was inserted (not just the literal query text).
  await page.keyboard.press("Control+Home");
  await sleep(120);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("```excalidraw");
});

// Fix #3 (ADR-017): vim G (jump to last line) must clear a macro that sits one line below
// the caret — blockEntry must not hijack a jump.
test("vim G jumps past a macro to the last line", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "gjump");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // caret will sit on "line2" (just above the macro) before G.
  for (const line of ["line1", "line2", "```mermaid", "graph TD; A-->B;", "```", "lastline"]) {
    await page.keyboard.type(line); await page.keyboard.press("Enter");
  }
  await sleep(300);
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "true");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  // Go to line 2 (just above the macro), then G.
  await page.keyboard.press("g"); await page.keyboard.press("g"); // line 1
  await page.keyboard.press("j"); // line 2 (the macro's near edge from above)
  await sleep(80);
  expect(await head(page)).toBe(2);
  await page.keyboard.press("Shift+G");
  await sleep(120);
  const line = await head(page);
  expect(line).toBeGreaterThanOrEqual(6); // reached the bottom (lastline/empty), NOT the macro (line 3)
});

// Fix #4 (ADR-017): a single-line vertical step from BELOW a tall block widget must move
// one line (to lastline), not warp past the block to the top.
test("ArrowUp / vim k from below a macro step one line (no warp)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "kstep");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["line1", "line2", "```mermaid", "graph TD; A-->B;", "```", "lastline"]) { await page.keyboard.type(l); await page.keyboard.press("Enter"); }
  await sleep(300);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").first().waitFor({ timeout: 15000 }).catch(() => {});
  await sleep(200);
  // NON-VIM ArrowUp from the very bottom → lastline (6), not a warp to line 1/2.
  await page.keyboard.press("Control+End"); await sleep(80);
  await page.keyboard.press("ArrowUp"); await sleep(100);
  expect(await head(page)).toBe(6);
  // VIM k from the bottom → also one line.
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "true");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+G"); await sleep(100); // to last line
  await page.keyboard.press("k"); await sleep(100);
  expect(await head(page)).toBeGreaterThanOrEqual(6); // stepped to lastline/empty, not warped up
});

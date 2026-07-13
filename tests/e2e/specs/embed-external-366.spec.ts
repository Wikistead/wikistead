import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const vimInsert = (p: import("@playwright/test").Page) => p.evaluate(() => (window as unknown as { __lpVimInsert?: boolean }).__lpVimInsert === true);

// #366 sub-target 3: embed-external is now an `atomSelectable` modal-completed atom, exactly like embed-page
// (#332). The /embed-external slash opens the in-app URL modal; on submit the block is inserted, vim drops
// to NORMAL, and the caret rests ON the rendered atom (card, never raw) with the fat cursor glyph BLANKED. The
// URL is re-edited via Ctrl+Enter (opens the SAME modal), not a caret-in raw reveal. Real Chromium + vim (the
// reveal boundary + vim-mode transition are synthetic-DOM-invisible).
test("#366: vim /embed-external modal insert selects the rendered atom; Ctrl+Enter reopens the URL modal", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "embed-external-366");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("i"); // INSERT mode — the slash palette is an insert-mode trigger
  await page.keyboard.type("/embed");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:embed-external"]');

  // The in-app URL modal opens (position=top, #344/#366 chrome) — enter a URL and save.
  await expect(page.getByTestId("embed-url-input")).toBeVisible();
  await page.getByTestId("embed-url-input").fill("https://example.com/watch");
  await page.getByTestId("embed-url-save").click();
  await expect(page.getByTestId("embed-url-input")).toHaveCount(0);
  await sleep(300);

  // The block renders as a widget (degrade link / iframe) — the raw `:::embed-external` never shows.
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain(":::embed-external");
  // vim is back in NORMAL and the caret rests ON the rendered atom (line 1), not stranded on a blank line.
  expect(await vimInsert(page), "vim dropped back to normal after the modal insert").toBe(false);
  const sel = await page.evaluate(() => {
    const pane = document.querySelector("[data-pane=preview]") as HTMLElement | null;
    const view = pane?.querySelector(".cm-editor") as HTMLElement | null;
    const fat = pane?.querySelector(".cm-fat-cursor") as HTMLElement | null;
    const w = window as unknown as { __lpHeadLine?: number; __lpBlocks?: { fromLine: number; toLine: number }[] };
    const h = w.__lpHeadLine ?? -1;
    return {
      headLine: h,
      onBlock: (w.__lpBlocks ?? []).some((b) => b.fromLine <= h && h <= b.toLine),
      blankClass: view?.classList.contains("cm-wys-blank-fatcursor") ?? false,
      fatGlyphColor: fat ? getComputedStyle(fat).color : null,
    };
  });
  expect(sel.headLine, "the caret is on the atom's opening line").toBe(1);
  expect(sel.onBlock, "the caret's line is inside the rendered macro block (the card), not a bare line").toBe(true);
  expect(sel.blankClass, "the blank-fatcursor class survives the modal's focus rebuild").toBe(true);
  expect(sel.fatGlyphColor, "the fat cursor glyph is transparent (no raw `:` leaks on the cursor)").toBe("rgba(0, 0, 0, 0)");

  // Ctrl+Enter on the selected atom opens the URL modal (the retarget UI), NOT a raw reveal — and it is seeded
  // with the current URL so the edit is a re-entry, not a blank prompt.
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("embed-url-input")).toBeVisible({ timeout: 4000 });
  await expect(page.getByTestId("embed-url-input")).toHaveValue("https://example.com/watch");
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain(":::embed-external");
  await page.keyboard.press("Escape"); // close without changing the target
  await expect(page.getByTestId("embed-url-input")).toHaveCount(0);
});

import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #550: an `:::embed-external` nested in a layout container (tabs / details) sat at its "…"
// placeholder forever — the host swap lived only in the top-level MacroWidget. The fix routes every
// surface through the host slot ({kind:"embed"}). Real Chromium: the WIDGET path (decorations'
// dispatch wiring) is what the happy-dom pins cannot exercise, and the ticket's report was exactly
// this surface (unfocused edit view + read view).
//
// The scratch tenant has no embed allowlist, so the URL degrades to a LINK — which is the point:
// the DEGRADE (host-checked answer) appearing at depth proves the seam ran; "…" means it did not.
// The allowlisted-iframe shape at depth is pinned in embed-nested-550.test.ts (unit, same builder).
const URL = "https://not-allowlisted.example/thing";
const DOC = `::::tabs
:::tab{title="A"}
:::embed-external
${URL}
:::
:::
::::

::::details{summary="More"}
:::embed-external
${URL}
:::
::::
`;

test("#550: nested embed-external renders the host-checked degrade link, not the … placeholder (edit surface, unfocused)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `embed-550-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(DOC);
  // Move the caret OUT of both containers (the ticket: focus-in rendered, focus-out fell back to …).
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\ntail");
  await sleep(800); // widgets rebuild after the caret leaves

  const pane = page.locator("[data-pane=preview]");
  await expect(pane.locator("[data-testid=macro-embed-degrade]").first()).toBeVisible({ timeout: 5000 });
  const counts = await pane.evaluate((root) => ({
    degrades: root.querySelectorAll("[data-testid=macro-embed-degrade]").length,
    dots: [...root.querySelectorAll("*")].filter((el) => el.textContent === "…" && el.children.length === 0).length,
  }));
  expect(counts.degrades, "both nested embeds (tabs + details) resolved through the host").toBeGreaterThanOrEqual(2);
  expect(counts.dots, "no … placeholder survives anywhere").toBe(0);
});

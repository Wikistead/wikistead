import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #393 / ADR-151 v1: whole-table BLOCK alignment via the `:::table{align=…}` directive attribute.
// Right-click (robust path) rewrites the attribute; center is the DEFAULT and writes NO attribute; the
// widget wears cm-lp-align-left/right only for the non-default (a bare :::table keeps the flow layout).
const TABLE = ":::table\n<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>\n:::";

const srcText = async (p: Page) => {
  await p.getByTestId("displaymode-source").click();
  await sleep(250);
  return p.locator("[data-pane=preview] .cm-content").innerText();
};

test("#393: right-click a :::table → Align right writes {align=right}; center drops it (round-trip)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-align-393");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`${TABLE}\n\nbelow\n`);
  await page.getByText("below", { exact: true }).click();
  await sleep(500);

  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await expect(wrap).toBeVisible();
  await expect(wrap).not.toHaveClass(/cm-lp-align-/); // default: NO align class (flow layout unchanged)

  await wrap.click({ button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("ctx-item-align-right").click();
  await expect(wrap).toHaveClass(/cm-lp-align-right/, { timeout: 8000 });

  // the table physically moved right (the flex align, not just a class)
  const wrapBox = (await wrap.boundingBox())!;
  const tableBox = (await wrap.locator("table").first().boundingBox())!;
  expect(tableBox.x + tableBox.width).toBeGreaterThan(wrapBox.x + wrapBox.width * 0.6);

  // back to center → the attribute is DROPPED (round-trip stable, fence-info convention)
  await wrap.click({ button: "right" });
  await page.getByTestId("ctx-item-align-center").click();
  await expect(wrap).not.toHaveClass(/cm-lp-align-right/, { timeout: 8000 });
  const s = await srcText(page);
  expect(s).toContain(":::table");
  expect(s).not.toContain("{align="); // center never persists an attribute
});

test("#393: a cell edit preserves the align attribute (the rewrite carries the fence)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-align-keep-393");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`:::table{align=left}\n<table><tr><th>H</th></tr><tr><td>x</td></tr></table>\n:::\n\nbelow\n`);
  await page.getByText("below", { exact: true }).click();
  await sleep(500);
  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await expect(wrap).toHaveClass(/cm-lp-align-left/);

  // enter the in-editor table edit — a `:::table` (richEditUI inline) enters on a body click directly
  // (#154/#395: the pipe×Live Ctrl+Enter opt-in is the OTHER quadrant). Each per-op commit rewrites the
  // :::table source through the host tier.
  await wrap.locator("td").first().click();
  await expect(page.getByTestId("table-edit")).toBeVisible({ timeout: 8000 });
  const cell = page.getByTestId("table-edit").locator("td").first();
  await cell.dblclick();
  await page.keyboard.press("Shift+Home");
  await page.keyboard.type("edited");
  await page.keyboard.press("Enter"); // commit the cell → the doc
  await sleep(300);
  await page.keyboard.press("Escape"); // exit edit mode
  await sleep(400);
  const s = await srcText(page);
  expect(s).toContain(":::table{align=left}"); // the cell edit did NOT strip the block alignment
  expect(s).toContain("edited");
});

test("#393: a nested :::table{align=right} aligns on the read/nested surface too (md-render path)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "table-align-nested-393");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`::::columns\n:::column\n:::table{align=right}\n<table><tr><td>n</td></tr></table>\n:::\n:::\n:::column\nplain\n:::\n::::\n\nbelow\n`);
  await page.getByText("below", { exact: true }).click();
  await sleep(700);
  // the nested render wraps the table in a fixed-class align wrapper (enum → class, never free text)
  const nestedWrap = page.locator("[data-pane=preview] .cm-lp-column .cm-lp-align-right").first();
  await expect(nestedWrap).toBeVisible({ timeout: 8000 });
  await expect(nestedWrap.locator("table")).toBeVisible();
});

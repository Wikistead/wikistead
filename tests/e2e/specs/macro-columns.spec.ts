import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #90 (ADR-043 A′): ::::columns renders as a side-by-side block-widget ATOM whose inner :::column
// items are rendered via the sanitized S0 Markdown→DOM renderer. Editing is reveal-on-cursor
// (caret-in shows the raw source). insertText is paste-like (bypasses the editor's auto-pairing
// that would mangle a typed ::: fence).
test("::::columns: side-by-side widget (S0-rendered inner md), edited via the editUI panel (not caret-in raw)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "columns");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::columns\n:::column\nLeft **bold**\n:::\n:::column\nRight side\n:::\n::::\n\nbelow\n");
  await sleep(400);

  const widget = page.locator("[data-pane=preview] [data-testid=macro-columns]");
  await expect(widget).toBeVisible();
  expect(await widget.locator(".cm-lp-column").count()).toBe(2);
  await expect(widget.locator("strong")).toContainText("bold"); // inner Markdown rendered (S0)
  await expect(widget.locator(".cm-lp-column").nth(1)).toContainText("Right side");
  // the raw ::: fences are hidden while the widget renders (caret is away, at "below")
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("::::columns");

  // #196 comment 786 (Option B, variant i): clicking the widget does NOT reveal raw — the flex layout is
  // preserved ALWAYS (reveal-on-cursor collapsed it). The block is edited via the editUI PANEL, reached from
  // the single edit button; the source textarea seeds the raw `::::columns` body + a live 2-column preview.
  await widget.click();
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("::::columns"); // still a widget
  await expect(page.locator("[data-pane=preview] [data-testid=macro-columns]")).toBeVisible(); // layout preserved
  await page.locator("[data-pane=preview] [data-testid=macro-edit]").first().click({ force: true });
  await sleep(300);
  // #257: the STRUCTURED panel — per-column chips + a content editor (markers hidden), NOT a raw textarea.
  await expect(page.locator("[data-pane=preview] [data-testid=layout-edit]")).toBeVisible();
  await expect(page.locator("[data-pane=preview] [data-testid=layout-edit-chip]")).toHaveCount(2); // 2 columns
  await expect(page.locator("[data-pane=preview] [data-testid=layout-edit-preview] .cm-lp-column")).toHaveCount(2); // live preview
});

// #257: the slash-inserted columns seed 2 columns, and the panel edits each column's content + adds/removes
// columns in-panel, reassembling the container body on save.
test("#257: columns editUI panel — 2-column seed, edit a column, add a third, round-trips", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "columns-257");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::columns\n:::column\nleft\n:::\n:::column\nright\n:::\n::::\n\nbelow\n");
  await sleep(400);
  await page.locator("[data-pane=preview] [data-testid=macro-edit]").first().click({ force: true });
  await sleep(300);
  const content = page.locator("[data-pane=preview] [data-testid=layout-edit-content]");
  await expect(content).toHaveValue("left"); // active = first column

  await content.fill("left-edited");
  await content.blur();
  await sleep(300);
  await page.locator("[data-pane=preview] [data-testid=layout-edit-add]").click();
  await sleep(400);
  // The add committed → the panel re-mounts from the new source with 3 columns (round-trip).
  await expect(page.locator("[data-pane=preview] [data-testid=layout-edit-chip]")).toHaveCount(3);
  // The edited first column survived: re-select it and confirm its content re-parsed from doc.
  await page.locator("[data-pane=preview] [data-testid=layout-edit-chip]").first().click();
  await expect(page.locator("[data-pane=preview] [data-testid=layout-edit-content]")).toHaveValue("left-edited");

  // Exit → the block re-renders as the columns widget with all three columns.
  await page.keyboard.press("Escape");
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-columns] .cm-lp-column")).toHaveCount(3);
});

test("::::columns inner content is sanitized — a <script> in a column makes no script element", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "columns-xss");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::columns\n:::column\n<script>alert(1)</script>\n:::\n:::column\nok\n:::\n::::\n\nbelow\n");
  await sleep(400);
  const widget = page.locator("[data-pane=preview] [data-testid=macro-columns]");
  await expect(widget).toBeVisible();
  expect(await widget.locator("script").count()).toBe(0); // rendered as literal text, not an element
});

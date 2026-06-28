import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #90 (ADR-043 A′): ::::columns renders as a side-by-side block-widget ATOM whose inner :::column
// items are rendered via the sanitized S0 Markdown→DOM renderer. Editing is reveal-on-cursor
// (caret-in shows the raw source). insertText is paste-like (bypasses the editor's auto-pairing
// that would mangle a typed ::: fence).
test("::::columns: side-by-side widget (S0-rendered inner md), caret-in reveals raw", async ({ browser }) => {
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

  // caret into the atom → reveal the raw source (round-trip: the source was always in the doc)
  await widget.click();
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("::::columns");
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

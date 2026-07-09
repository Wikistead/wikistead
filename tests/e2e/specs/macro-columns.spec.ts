import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #90 (ADR-043 A′): ::::columns renders as a side-by-side block-widget ATOM whose inner :::column
// items are rendered via the sanitized S0 Markdown→DOM renderer. Editing is reveal-on-cursor
// (caret-in shows the raw source). insertText is paste-like (bypasses the editor's auto-pairing
// that would mangle a typed ::: fence).
test("::::columns: side-by-side widget (S0-rendered inner md); a slot is edited by an inline CM6 island (#278 §2a)", async ({ browser }) => {
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
  expect(await page.locator("[data-pane=preview] .cm-content").first().innerText()).not.toContain("::::columns");

  // #278 §2a / ADR-122 (A): clicking a slot's content mounts an inline CM6 island IN that cell — NOT a caret-in
  // raw reveal (Option B rejected; the flex layout is preserved because the island is DOM inside the cell) and
  // NOT the retired #257 panel. The other column stays rendered side-by-side.
  await widget.locator(".cm-lp-column").first().click();
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=slot-edit-src]")).toBeVisible();
  await expect(page.locator("[data-pane=preview] [data-testid=macro-columns]")).toBeVisible(); // layout preserved
  await expect(page.locator("[data-pane=preview] .cm-lp-column")).toContainText("Right side"); // the other slot renders
  // the retired panel is gone.
  await expect(page.locator("[data-pane=preview] [data-testid=layout-edit]")).toHaveCount(0);
});

// #278 §2a: edit a column's content via the inline CM6 island (commit-on-blur → one Y.Text replace), then add
// a third column via the inline — the edited content round-trips through the structural change.
test("#278 §2a: inline island edits a column; the inline ＋ adds a third; the edit round-trips", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "columns-278");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::columns\n:::column\nleft\n:::\n:::column\nright\n:::\n::::\n\nbelow\n");
  await sleep(400);
  await page.getByText("below").click(); await sleep(200); // caret out → widget renders

  // edit the first column via the inline island.
  await page.locator("[data-pane=preview] [data-testid=macro-columns] .cm-lp-column").first().click();
  await sleep(300);
  const src = page.locator("[data-pane=preview] [data-testid=slot-edit-src]");
  await expect(src).toBeVisible();
  await src.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("left-edited");
  await page.getByText("below").click(); // blur → commit-on-blur
  await sleep(400);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-columns] .cm-lp-column").first()).toContainText("left-edited");

  // add a third column via the inline ; the edited first column survives the round-trip.
  await page.locator("[data-pane=preview] [data-testid=macro-columns]").hover();
  await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=layout-add-column]").click({ force: true });
  await sleep(400);
  await page.getByText("below").click();
  await sleep(200);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-columns] .cm-lp-column")).toHaveCount(3);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-columns] .cm-lp-column").first()).toContainText("left-edited");
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

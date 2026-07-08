import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #90 (ADR-043 A′): ::::tabs renders as a block-widget ATOM with a tab bar + only the active
// panel shown. Switching tabs is DISPLAY-ONLY (no doc write); editing is reveal-on-cursor.
test("::::tabs: tab bar + active panel, switch is display-only, edited via the editUI panel (not caret-in raw)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tabs");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::tabs\n:::tab[One]\nfirst **a**\n:::\n:::tab[Two]\nsecond panel\n:::\n::::\n\nbelow\n");
  await sleep(400);

  const widget = page.locator("[data-pane=preview] [data-testid=macro-tabs]");
  await expect(widget).toBeVisible();
  expect(await widget.locator(".cm-lp-tab").count()).toBe(2);
  await expect(widget.locator(".cm-lp-tabpanel-active")).toContainText("first"); // first tab active by default
  await expect(widget.locator("strong")).toContainText("a"); // inner md rendered (S0)

  // Click the second tab → the active panel switches; the widget stays rendered (display-only,
  // not entering edit) and the raw source is NOT revealed.
  await widget.locator(".cm-lp-tab", { hasText: "Two" }).click();
  await sleep(150);
  await expect(widget.locator(".cm-lp-tabpanel-active")).toContainText("second panel");
  await expect(widget).toBeVisible();
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("::::tabs");

  // #196 comment 786 (Option B, variant i): clicking the panel body does NOT reveal raw — the tab widget is
  // preserved ALWAYS. Editing is via the editUI PANEL (single edit button → source textarea + live preview),
  // so the layout never collapses.
  await widget.locator(".cm-lp-tabpanel-active").click();
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("::::tabs"); // still a widget
  await page.locator("[data-pane=preview] [data-testid=macro-edit]").first().click({ force: true });
  await sleep(300);
  // #257: the STRUCTURED panel — a tab bar (chips) + a per-tab content editor, NOT a raw `:::tab` textarea.
  await expect(page.locator("[data-pane=preview] [data-testid=layout-edit]")).toBeVisible();
  const chips = page.locator("[data-pane=preview] [data-testid=layout-edit-chip]");
  await expect(chips).toHaveCount(2);
  // The active tab's content is edited directly (markers hidden); the first tab shows "first **a**".
  await expect(page.locator("[data-pane=preview] [data-testid=layout-edit-content]")).toHaveValue(/first/);
});

// #257: the structured tabs panel edits each tab's content (markers hidden), switches tabs in-panel, adds a
// tab, and reassembles the container body on save — a round-trip through the single Y.Text.
test("#257: tabs editUI panel — switch tabs, edit content, add a tab, round-trips the source", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tabs-257");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::tabs\n:::tab[One]\nalpha\n:::\n:::tab[Two]\nbeta\n:::\n::::\n\nbelow\n");
  await sleep(400);
  await page.locator("[data-pane=preview] [data-testid=macro-edit]").first().click({ force: true });
  await sleep(300);
  const content = page.locator("[data-pane=preview] [data-testid=layout-edit-content]");
  await expect(content).toHaveValue("alpha"); // active = first tab

  // Switch to the second tab in-panel → its content loads.
  await page.locator("[data-pane=preview] [data-testid=layout-edit-chip]", { hasText: "Two" }).click();
  await expect(content).toHaveValue("beta");

  // Edit the second tab's content and commit (blur), then add a third tab.
  await content.fill("beta-edited");
  await content.blur();
  await sleep(300);
  await page.locator("[data-pane=preview] [data-testid=layout-edit-add]").click();
  await sleep(400);
  // The add committed to the doc → the panel re-mounts from the new source with 3 tabs (round-trip).
  await expect(page.locator("[data-pane=preview] [data-testid=layout-edit-chip]")).toHaveCount(3);
  // The edited second tab survived the round-trip: re-select it and confirm its content re-parsed from doc.
  await page.locator("[data-pane=preview] [data-testid=layout-edit-chip]", { hasText: "Two" }).click();
  await expect(page.locator("[data-pane=preview] [data-testid=layout-edit-content]")).toHaveValue("beta-edited");

  // Exit → the block re-renders as the tabs widget with all three tabs (rendered, not raw).
  await page.keyboard.press("Escape");
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-tabs] .cm-lp-tab")).toHaveCount(3);
});

// XSS boundary (parity with ::::columns): a tab panel's inner Markdown is rendered via the S0
// sanitizer (textContent + allowlist), so raw HTML is LITERAL TEXT — a <script>/<img onerror>
// in a panel produces no element. (Tabs went through S0 like columns but lacked an XSS test.)
test("::::tabs inner content is sanitized — a <script>/<img onerror> in a panel makes no element", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tabs-xss");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::tabs\n:::tab[One]\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n:::\n:::tab[Two]\nok\n:::\n::::\n\nbelow\n");
  await sleep(400);
  const widget = page.locator("[data-pane=preview] [data-testid=macro-tabs]");
  await expect(widget).toBeVisible();
  expect(await widget.locator("script").count()).toBe(0); // literal text, not a script element
  expect(await widget.locator("img").count()).toBe(0);    // no img → no onerror to fire
});

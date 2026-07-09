import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #90 (ADR-043 A′): ::::tabs renders as a block-widget ATOM with a tab bar + only the active
// panel shown. Switching tabs is DISPLAY-ONLY (no doc write); editing is reveal-on-cursor.
test("::::tabs: tab bar + active panel, switch is display-only; the active panel is edited by an inline CM6 island (#278 §2a)", async ({ browser }) => {
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
  expect(await page.locator("[data-pane=preview] .cm-content").first().innerText()).not.toContain("::::tabs");

  // #278 §2a / ADR-122 (A): clicking the ACTIVE panel's content mounts an inline CM6 island IN that panel
  // NOT a caret-in raw reveal and NOT the retired #257 panel. Only the active tab is edited.
  await widget.locator(".cm-lp-tabpanel-active").click();
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=slot-edit-src]")).toBeVisible();
  await expect(page.locator("[data-pane=preview] [data-testid=macro-tabs]")).toBeVisible();
  await expect(page.locator("[data-pane=preview] [data-testid=layout-edit]")).toHaveCount(0); // the panel is retired
});

// #278 §2a: switch to a tab, edit its ACTIVE panel via the inline CM6 island (commit-on-blur), then add a tab
// via the inline — the edit round-trips through the structural change (single Y.Text).
test("#278 §2a: inline island edits the active tab; the inline ＋ adds a tab; the edit round-trips", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tabs-278");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::tabs\n:::tab[One]\nalpha\n:::\n:::tab[Two]\nbeta\n:::\n::::\n\nbelow\n");
  await sleep(400);
  await page.getByText("below").click(); await sleep(200); // caret out → widget renders

  // switch to the SECOND tab, then edit its active panel via the inline island.
  await page.locator("[data-pane=preview] [data-testid=macro-tabs] .cm-lp-tab", { hasText: "Two" }).click();
  await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=macro-tabs] .cm-lp-tabpanel-active").click();
  await sleep(300);
  const src = page.locator("[data-pane=preview] [data-testid=slot-edit-src]");
  await expect(src).toBeVisible();
  await expect(src).toContainText("beta"); // the island holds the ACTIVE tab's body (active tab only)
  await src.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("beta-edited");
  await page.getByText("below").click(); // blur → commit
  await sleep(400);

  // add a third tab via the inline ; the edited second tab survives the round-trip.
  await page.locator("[data-pane=preview] [data-testid=macro-tabs]").hover();
  await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=layout-add-tab]").click({ force: true });
  await sleep(400);
  await page.getByText("below").click();
  await sleep(200);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-tabs] .cm-lp-tab")).toHaveCount(3);
  await page.locator("[data-pane=preview] [data-testid=macro-tabs] .cm-lp-tab", { hasText: "Two" }).click();
  await expect(page.locator("[data-pane=preview] [data-testid=macro-tabs] .cm-lp-tabpanel-active")).toContainText("beta-edited");
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

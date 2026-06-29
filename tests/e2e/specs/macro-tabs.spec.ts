import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #90 (ADR-043 A′): ::::tabs renders as a block-widget ATOM with a tab bar + only the active
// panel shown. Switching tabs is DISPLAY-ONLY (no doc write); editing is reveal-on-cursor.
test("::::tabs: tab bar + active panel, switch is display-only, caret-in reveals raw", async ({ browser }) => {
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

  // Clicking the panel body (not a tab) enters the atom → reveal raw source.
  await widget.locator(".cm-lp-tabpanel-active").click();
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("::::tabs");
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

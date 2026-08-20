import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M1 slice 2 (ADR-022) + #150 typed callouts (ADR-049) + #170 Y: the ::: container directive path.
// A typed callout (:::note/:::info/:::tip/:::warning/:::danger) renders as a single-container PANEL
// widget (enter-to-edit, like columns/tabs): caret-OUT shows a flex 2-column panel (large icon +
// variant title + nested Markdown body), caret-IN reveals the raw ::: source. An unknown type falls
// back to note, and lookup is case-insensitive.
//
// REAL throwaway page so the transient presence caret can't ghost other demo specs.
test(":::note directive: panel widget, nested markdown, hide-fence + round-trip", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of [":::note", "Heads up **bold** inside.", ":::", "", "below the callout"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);

  // Caret is below → the callout renders as a PANEL widget (not raw, not per-line boxes).
  const panel = page.locator("[data-pane=preview] .cm-lp-callout-panel").first();
  await expect(panel).toBeVisible();
  // The body stays Markdown: the **bold** is rendered as a real <strong> inside the panel body.
  await expect(panel.locator(".cm-lp-callout-panel-body strong")).toContainText("bold");
  const visible = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(visible).toContain("Heads up");
  expect(visible).not.toContain(":::note");

  // Round-trip: click the panel (enter) then caret onto the opening fence line reveals raw ::: source.
  await panel.click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain(":::note");
});

// #150 / #170 Y: each type renders its own modifier class + a large icon column + a [label] (#94)
// title, laid out as the flex panel (icon vertically centred, not a tiny top-left glyph).
test(":::warning[label] renders the warning panel with a large icon column + title", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout-warning");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of [":::warning[Server down]", "body text", ":::", "", "after"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);

  const panel = page.locator("[data-pane=preview] .cm-lp-callout-warning.cm-lp-callout-panel").first();
  await expect(panel).toBeVisible();
  // #94 label → the panel title (variant-coloured), via textContent (XSS-safe).
  const title = panel.locator(".cm-lp-callout-panel-title");
  await expect(title).toHaveAttribute("data-label", "Server down");
  await expect(title).toHaveText("Server down");
  // #158-C4 icon: the masked Lucide SVG rides the icon column (mask-image, not "none").
  const icon = panel.locator(".cm-lp-callout-panel-icon");
  await expect(icon).toHaveAttribute("data-icon", "triangle-alert");
  const mask = await icon.evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage);
  expect(mask).toContain("svg"); // a mask-image SVG data URI is set
  // #170 panel geometry: a LARGE icon column (~1.75em ≈ 28px), not the old ~1em glyph, and the panel
  // lays out as a flex row (icon column beside the main column).
  const geo = await icon.evaluate((el) => ({ w: parseFloat(getComputedStyle(el).width) }));
  expect(geo.w).toBeGreaterThan(18);
  const display = await panel.evaluate((el) => getComputedStyle(el).display);
  expect(display).toBe("flex"); // the option-Y flex panel (not the old per-line boxes)
  const visible = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(visible).not.toContain(":::warning[Server down]"); // raw hidden (no linkification — #94)
});

// #150: an unknown type falls back to a note callout (Obsidian-compatible).
test(":::foobar (unknown type) falls back to a note callout panel", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout-fallback");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  for (const line of [":::foobar", "unknown type body", ":::", "", "after"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);
  await expect(page.locator("[data-pane=preview] .cm-lp-callout-note.cm-lp-callout-panel").first()).toBeVisible();
});

// #150: type id is case-insensitive (:::WARNING == :::warning).
test(":::WARNING is case-insensitive (renders the warning panel)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout-case");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  for (const line of [":::WARNING", "shouty", ":::", "", "after"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);
  await expect(page.locator("[data-pane=preview] .cm-lp-callout-warning.cm-lp-callout-panel").first()).toBeVisible();
});

import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M1 slice 2 (ADR-022) + #150 typed callouts (ADR-049): the ::: container directive path.
// A typed callout (:::note/:::info/:::tip/:::warning/:::danger) renders as a styled box whose
// content stays live-preview Markdown, the ::: fences hide (reveal-on-cursor), the source
// round-trips, an unknown type falls back to note, and lookup is case-insensitive.
//
// REAL throwaway page so the transient presence caret can't ghost other demo specs.
test(":::note directive: styled box, nested markdown, hide-fence + round-trip", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of [":::note", "Heads up **bold** inside.", ":::", "", "below the callout"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);

  const box = page.locator("[data-pane=preview] .cm-lp-callout").first();
  await expect(box).toBeVisible();
  // Content stays Markdown: the **bold** is decorated (nested parsing, not an opaque widget).
  await expect(page.locator("[data-pane=preview] .cm-lp-strong")).toContainText("bold");
  const visible = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(visible).toContain("Heads up");
  expect(visible).not.toContain(":::note");

  // Round-trip: caret onto the opening fence line reveals the raw ::: source.
  await box.click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain(":::note");
});

// #150: each type renders its own modifier class + header icon; a [label] (#94) is the header.
test(":::warning[label] renders the warning variant with icon + label header", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout-warning");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of [":::warning[Server down]", "body text", ":::", "", "after"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);

  await expect(page.locator("[data-pane=preview] .cm-lp-callout-warning").first()).toBeVisible();
  const header = page.locator("[data-pane=preview] .cm-lp-directive-label").first();
  await expect(header).toHaveAttribute("data-label", "Server down"); // #94 label
  await expect(header).toHaveAttribute("data-icon", "triangle-alert"); // #158-C4 Lucide icon name
  // #158-C4: the icon renders as a mask-image on ::before (Lucide SVG, currentColor-tinted).
  const beforeMask = await header.evaluate((el) => getComputedStyle(el, "::before").maskImage || getComputedStyle(el, "::before").webkitMaskImage);
  expect(beforeMask).toContain("svg"); // a mask-image SVG data URI is set (not "none")
  // #170 panel layout: the icon is a LARGE gutter column (absolutely positioned in the callout's
  // left padding), not a tiny inline glyph. Assert the panel geometry.
  const iconStyle = await header.evaluate((el) => {
    const b = getComputedStyle(el, "::before");
    return { position: b.position, width: parseFloat(b.width) };
  });
  expect(iconStyle.position).toBe("absolute");     // in the gutter, not inline
  expect(iconStyle.width).toBeGreaterThan(18);     // large (~1.5em ≈ 24px), not the old ~1em glyph
  const boxPadLeft = await page.locator("[data-pane=preview] .cm-lp-callout-warning").first()
    .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(boxPadLeft).toBeGreaterThan(28);          // the left gutter reserves the icon column
  const visible = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(visible).not.toContain(":::warning[Server down]"); // raw hidden (no linkification — #94)
});

// #150: an unknown type falls back to a note callout (Obsidian-compatible).
test(":::foobar (unknown type) falls back to a note callout", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout-fallback");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  for (const line of [":::foobar", "unknown type body", ":::", "", "after"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);
  await expect(page.locator("[data-pane=preview] .cm-lp-callout-note").first()).toBeVisible();
});

// #150: type id is case-insensitive (:::WARNING == :::warning).
test(":::WARNING is case-insensitive (renders the warning variant)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout-case");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  for (const line of [":::WARNING", "shouty", ":::", "", "after"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);
  await expect(page.locator("[data-pane=preview] .cm-lp-callout-warning").first()).toBeVisible();
});

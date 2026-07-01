import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// ADR-056 / #164 · #165: the editor display mode is an editor-wide axis, orthogonal to vim. The toolbar
// shows an icon-only SEGMENT (Live/Source/Reading/WYSIWYG) with the current mode highlighted; one click
// switches DIRECTLY (no per-switch toast — the highlight is the feedback). Ctrl+Alt+E still cycles.
// Live = reveal syntax under the caret only; Source = syntax always raw; Reading = clean render,
// read-only (no grips, no checkbox toggles). Display-only: the doc never changes.
test("display-mode segment: direct switch live/source/reading (display-only)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "dispmode");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // A callout (:::note, container macro) AND a mermaid fence (a liveRender WIDGET macro) — #165: both
  // must show RAW in Source mode. The widget macro is the one that regressed (it kept rendering).
  await page.keyboard.insertText(":::note\nhello body\n:::\n\n```mermaid\ngraph TD; A-->B\n```\n\nplain tail\n");
  await sleep(300);
  await page.keyboard.press("Control+End"); // caret away from the callout so Live hides the fence
  await sleep(200);

  const content = () => page.locator("[data-pane=preview] .cm-content").innerText();
  const segment = page.getByTestId("displaymode-segment");
  const grips = page.locator("[data-pane=preview] [data-testid=block-grip]");
  // Direct switch by clicking the mode's segment button, then assert the segment reflects it.
  const setMode = async (m: string) => {
    await page.getByTestId(`displaymode-${m}`).click();
    await sleep(250);
    await expect(segment).toHaveAttribute("data-mode", m);
  };

  // Live: fence hidden; the surface is editable (grips present). The mermaid widget renders (its raw
  // fence is NOT shown in live).
  await setMode("live");
  expect(await content()).not.toContain(":::note");
  expect(await content()).not.toContain("```mermaid");
  expect(await grips.count()).toBeGreaterThan(0);

  // Source: syntax always raw — BOTH the callout AND the liveRender widget macro (mermaid) show raw
  // source (#165: the widget macro previously kept rendering in Source — regression guard).
  await setMode("source");
  expect(await content()).toContain(":::note");
  expect(await content()).toContain("```mermaid");
  expect(await content()).toContain("graph TD");

  // Reading: clean render (no syntax), read-only (contenteditable=false, no grips).
  await setMode("reading");
  expect(await content()).not.toContain(":::note");
  expect(await page.locator("[data-pane=preview] .cm-content").getAttribute("contenteditable")).toBe("false");
  expect(await grips.count()).toBe(0); // no drag affordance on a clean reading view

  // Back to Live (display-only: the doc never changed — fence hidden again, editable again).
  await setMode("live");
  expect(await content()).not.toContain(":::note");
  expect(await page.locator("[data-pane=preview] .cm-content").getAttribute("contenteditable")).toBe("true");

  // The active mode button is marked (highlight = the always-visible "current mode" cue; no toast).
  await expect(page.getByTestId("displaymode-live")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("displaymode-source")).toHaveAttribute("data-active", "false");

  // Ctrl+Alt+E still CYCLES (live → source), proving the keyboard path survives the segment UI.
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Control+Alt+e");
  await sleep(250);
  await expect(segment).toHaveAttribute("data-mode", "source");
});

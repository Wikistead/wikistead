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

  // Reading: clean render (no syntax), read-only, no grips. #165: it stays EDITABLE-focusable
  // (contenteditable=true) so vim navigation survives — read-only-ness is enforced by
  // EditorState.readOnly (edits are dropped), NOT by making the view non-editable.
  await setMode("reading");
  expect(await content()).not.toContain(":::note");
  expect(await page.locator("[data-pane=preview] .cm-content").getAttribute("contenteditable")).toBe("true");
  expect(await grips.count()).toBe(0); // no drag affordance on a clean reading view
  // read-only: typing does not change the document.
  const beforeType = await content();
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("ZZTYPED");
  await sleep(150);
  expect(await content()).toBe(beforeType); // edits blocked in reading

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

// #165 rebound (vim ⟂ display mode): switching to Reading must NOT kill vim — vim navigation (j/k)
// keeps working in Reading (edits blocked, motion allowed), and vim fully survives returning to
// Live. Regression guard for the bug where Reading set the view non-editable, disabling the vim
// keymap and never re-enabling it on the way out.
test("#165: vim navigation survives a Reading round-trip (nav in Reading + restored after)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "dispmode-vim");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("L0\nL1\nL2\nL3\n");
  await sleep(200);
  await page.getByTestId("vim-toggle").click(); // vim ON
  await sleep(200);
  const head = () => page.evaluate(() => (window as Window & { __lpHeadLine?: number }).__lpHeadLine);
  const normalTop = async () => { await page.click("[data-pane=preview] .cm-content"); await page.keyboard.press("Escape"); await page.keyboard.type("gg"); await sleep(150); };

  // Reading: vim j still moves the caret (motion works though edits are blocked).
  await page.getByTestId("displaymode-reading").click();
  await sleep(250);
  await normalTop();
  const rBefore = await head();
  await page.keyboard.press("j");
  await sleep(150);
  expect(await head()).toBe((rBefore ?? 1) + 1); // vim motion works IN Reading (not disabled)

  // Back to Live: vim is fully restored (j still moves — not typing a literal 'j').
  await page.getByTestId("displaymode-live").click();
  await sleep(250);
  await normalTop();
  const lBefore = await head();
  await page.keyboard.press("j");
  await sleep(150);
  expect(await head()).toBe((lBefore ?? 1) + 1); // vim survived Reading → Live
});

// #174-#4 / #165: Reading is read-only, so clicking a table must NOT enter editing (the static
// TableWidget's click handler still fires now that Reading stays focusable — openTableEditing guards
// on state.readOnly). Regression guard: no in-editor table editor appears in Reading.
test("#174: Reading blocks table editing (click does not open the in-editor editor)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "dispmode-readonly-table");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  for (const l of ["| A | B |", "| --- | --- |", "| 1 | 2 |", "", "below"]) { await page.keyboard.type(l); await page.keyboard.press("Enter"); }
  await sleep(250);
  await page.getByTestId("displaymode-reading").click();
  await sleep(250);
  // the table still renders (read view), but a click does not enter the editor.
  const tbl = page.locator("[data-pane=preview] table.cm-lp-table");
  await expect(tbl).toBeVisible();
  await tbl.click();
  await sleep(200);
  expect(await page.getByTestId("table-edit").count()).toBe(0); // no in-editor editor in Reading
});

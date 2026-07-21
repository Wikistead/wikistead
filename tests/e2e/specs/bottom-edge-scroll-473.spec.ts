import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #473: "adding a line near the viewport bottom throws the view ~100px". Measured, the picture is
// narrower than the report: sustained typing at the bottom does NOT jump — the caret settles at a
// rest line (the #306 scrolloff band edge) and each new line scrolls exactly one line height with
// the caret fixed on screen. The ~100px correction happens ONCE, when a CLICK has parked the caret
// below that rest line (clicking deliberately never scrolls —) and the first edit re-aligns
// the view in one step.
//
// Note for whoever measures this next: drive it with real typing. Pressing End between lines is a
// selection-only motion, which legitimately wakes the #306 scrolloff and makes the caret see-saw by
// a line — an artifact of the harness, not of the editor (that cost an afternoon to see).
//
// The good steady state is what this pins, so it cannot regress while the one-time correction is
// discussed. If that correction is later smoothed, these pins still hold.

const geo = (p: Page) => p.evaluate(() => {
  const ed = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
  const view = (ed?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as {
    state: { selection: { main: { head: number } } };
    coordsAtPos(p: number): { top: number; bottom: number } | null;
    scrollDOM: HTMLElement;
  };
  const c = view.coordsAtPos(view.state.selection.main.head)!;
  return { caretTop: Math.round(c.top), scrollTop: Math.round(view.scrollDOM.scrollTop) };
});

const FILLER = Array.from({ length: 40 }, (_, i) => `plain text line ${i}`).join("\n");

test("#473: sustained typing at the bottom scrolls one line at a time, with the caret fixed on screen", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `scroll473-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`top\n${FILLER}\n`);
  await sleep(1200);

  // walk down until the view starts following the caret, then measure the steady state
  await page.getByText("plain text line 30", { exact: true }).click();
  await sleep(400);
  await page.keyboard.press("End");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    await sleep(250);
  }

  const samples: { scroll: number; caret: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const before = await geo(page);
    await page.keyboard.type("line");
    await page.keyboard.press("Enter");
    await sleep(300);
    const after = await geo(page);
    samples.push({ scroll: after.scrollTop - before.scrollTop, caret: after.caretTop - before.caretTop });
  }

  for (const [i, s] of samples.entries()) {
    expect(Math.abs(s.caret), `step ${i}: the caret stays put on screen (samples: ${JSON.stringify(samples)})`).toBeLessThanOrEqual(4);
    expect(s.scroll, `step ${i}: the view follows by about one line, not a lurch`).toBeLessThanOrEqual(40);
  }
});

test("#473: the caret never ends up hidden behind the floating controls strip", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `scroll473b-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`top\n${FILLER}\n`);
  await sleep(1200);
  await page.getByText("plain text line 38", { exact: true }).click();
  await sleep(400);
  await page.keyboard.press("End");
  for (let i = 0; i < 10; i++) {
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    await sleep(200);
  }
  await page.keyboard.insertText("still visible");
  await sleep(400);

  const clear = await page.evaluate(() => {
    const ed = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
    const view = (ed?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as {
      state: { selection: { main: { head: number } } };
      coordsAtPos(p: number): { bottom: number } | null;
      scrollDOM: HTMLElement;
    };
    const c = view.coordsAtPos(view.state.selection.main.head)!;
    return Math.round(view.scrollDOM.getBoundingClientRect().bottom - c.bottom);
  });
  // the 72px clearance (the controls strip / .cm-content padding-bottom) is why the view scrolls at all
  expect(clear, "the line being typed keeps clearance above the controls strip").toBeGreaterThanOrEqual(72);
});

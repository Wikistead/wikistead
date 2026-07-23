import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #278 the three island regressions the review reported, pinned as permanent guards now
// that they are fixed/absent on master (measured 2026-07-23; ① was closed by the boundary
// scoping + body-line caret park, ②③ did not reproduce):
//   ① island chrome (the callout ✎ / Ctrl+↵ pill) must NOT stay lit while the island merely has focus —
//     only its own hover/caret reveals it (the descendant-selector leak class);
//   ② entering a NESTED callout must reveal its own ```:::``` fences only — never a stray lone colon
//     (the nested-container colon-count off-by-one class), pinned for 4-colon columns AND 5-colon tabs;
//   ③ walking the caret toward the callout inside the island must not oscillate the island scroller
//     into a flickering scrollbar (the reveal-driven height oscillation class).

const COLS = "top\n\n::::columns\n:::column\nintro line\n\n:::warning\nhi there\n:::\n\nafter line\n:::\n:::column\nBBB\n:::\n::::\n\nbottom line\n";
const TABS = ":::::tabs\n::::tab[One]\nintro one\n\n:::warning\ndeep body\n:::\n\ntail one\n::::\n::::tab[Two]\ntwo body\n::::\n:::::\n\nbottom line\n";

const strayColonsOf = (lines: string[]) =>
  lines.filter((t) => /^:{1,2}$/.test(t) || (/^:{1,2}[^:]/.test(t) && !t.startsWith(":::")));

test("#278 ①③: island chrome stays hidden without hover/caret; no scrollbar flicker on approach", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `c2234a-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(COLS);
  await sleep(900);

  await page.getByText("intro line", { exact: true }).click(); // one click enters the column island
  await sleep(700);
  const island = page.locator(".cm-lp-slot-edit-island").first();
  await expect(island).toHaveCount(1);

  // ① caret on a plain line, mouse parked far away → every pill/✎ inside the island is invisible
  await page.mouse.move(4, 4);
  await sleep(400);
  const litChrome = await island.evaluate((el) => {
    const out: string[] = [];
    el.querySelectorAll(".cm-lp-macro-richui-raw, .cm-lp-macro-edit").forEach((p) => {
      if (getComputedStyle(p).opacity !== "0") out.push((p as HTMLElement).className.slice(0, 60));
    });
    return out;
  });
  expect(litChrome, "no island chrome is lit without its own hover/caret").toEqual([]);

  // ③ from 'after line' walk the caret up toward the warning while sampling the island scroller —
  // the overflow state must never flip on (a reveal-driven height oscillation would flicker it)
  await page.getByText("after line", { exact: true }).click();
  await sleep(300);
  const sample = island.evaluate(async (el) => {
    const states: string[] = [];
    for (let i = 0; i < 40; i++) {
      const scroller = (el.querySelector(".cm-scroller") as HTMLElement | null) ?? (el as HTMLElement);
      states.push(scroller.scrollHeight > scroller.clientHeight ? "S" : "-");
      await new Promise((r) => requestAnimationFrame(r));
    }
    return states.join("");
  });
  const move = (async () => { for (let i = 0; i < 8; i++) { await page.keyboard.press("ArrowUp"); await sleep(60); } })();
  const [timeline] = await Promise.all([sample, move]);
  expect(timeline, `the island scroller never grows a scrollbar while the caret approaches (${timeline})`).not.toContain("S");
});

for (const [label, fixture, enter, body] of [
  ["columns (4-colon)", COLS, "intro line", "hi there"],
  ["tabs (5-colon)", TABS, "intro one", "deep body"],
] as const) {
  test(`#278 ②: no stray colon when the caret enters a nested callout — ${label}`, async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await openScratch(page, `c2234b-${Date.now().toString(36)}`);
    await enterEdit(page);
    await page.click("[data-pane=preview] .cm-content");
    await page.keyboard.insertText(fixture);
    await sleep(900);

    await page.getByText(enter, { exact: true }).click();
    await sleep(700);
    const island = page.locator(".cm-lp-slot-edit-island").first();
    await expect(island).toHaveCount(1);

    await page.getByText(body, { exact: true }).click(); // caret into the nested callout body
    await sleep(500);
    const lines = await island.evaluate((el) =>
      Array.from(el.querySelectorAll(".cm-line")).map((l) => (l.textContent ?? "").trim()).filter((t) => t.length > 0));
    // the callout's own full fences may reveal (normal caret-in reveal); a LONE : or :: must not
    expect(strayColonsOf(lines), `island lines: ${JSON.stringify(lines)}`).toEqual([]);
  });
}

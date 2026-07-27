import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #528 / ADR-192: one layout owner for every block affordance. The pin is the PROPERTY the ticket asks for —
// no two visible affordances of a block overlap — measured the way the collision was found (#528):
// a nested macro with the caret inside it shows the raw rich-edit pill AND the ✎ chrome row, and before the
// owner existed their rectangles intersected by 8px because both claimed `top:-1.5em; left:0` from different
// offset parents.
const NESTED = `::::columns
:::column
:::note[Inner]
inner body text
:::
:::
:::column
right side
:::
::::

tail line
`;

const AFFORDANCE_SEL = ".cm-macro-presence-box, .cm-lp-macro-btnrow, .cm-lp-macro-richui-raw";

async function visibleAffordances(page: import("@playwright/test").Page) {
  return page.evaluate((sel) => {
    const out: { cls: string; top: number; bottom: number; left: number; right: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      if (parseFloat(cs.opacity || "1") <= 0.01) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({ cls: el.className, top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
    return out;
  }, AFFORDANCE_SEL);
}

const intersects = (a: { top: number; bottom: number; left: number; right: number }, b: typeof a) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test("#528: the visible block affordances never overlap (caret inside a nested macro)", async ({ page }) => {
  await openScratch(page, `aff528-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(NESTED);
  await sleep(600);

  // put the caret on the inner macro — the state that makes both affordances visible at once
  await page.getByText("inner body text", { exact: false }).first().click();
  await sleep(500);

  const rects = await visibleAffordances(page);
  // the collision only exists when at least two are visible; if the fixture stops producing that, say so
  // rather than passing vacuously.
  expect(rects.length, `expected 2+ visible affordances, saw ${JSON.stringify(rects)}`).toBeGreaterThanOrEqual(2);

  const collisions: string[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (intersects(rects[i]!, rects[j]!)) {
        const ov = Math.min(rects[i]!.bottom, rects[j]!.bottom) - Math.max(rects[i]!.top, rects[j]!.top);
        collisions.push(`${rects[i]!.cls} × ${rects[j]!.cls} (${Math.round(ov)}px)`);
      }
    }
  }
  expect(collisions, "no two visible affordances may share screen space").toEqual([]);
});

test("#528: resolving the collision must not hide anything (discoverability, approval condition 2)", async ({ page }) => {
  await openScratch(page, `aff528v-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(NESTED);
  await sleep(600);
  await page.getByText("inner body text", { exact: false }).first().click();
  await sleep(500);

  const rects = await visibleAffordances(page);
  const scroller = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-pane=preview] .cm-scroller");
    const r = el!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  // every affordance the owner placed is still ON SCREEN — "no longer overlapping, no longer visible" is the
  // failure mode #456 was rejected for.
  for (const r of rects) {
    expect(r.top, `${r.cls} above the surface`).toBeGreaterThanOrEqual(scroller.top - 1);
    expect(r.bottom, `${r.cls} below the surface`).toBeLessThanOrEqual(scroller.bottom + 1);
  }
});

// #528 decision 2 (innermost-only). Measured first (#528predicted the target was the ✎ BUTTON, not a
// tooltip): with the caret inside `::::columns > :::column > :::note`, only the innermost block renders an
// entry affordance — an ancestor never shows one at the same time. That is the property the decision asks
// for, and it already holds, so this pins it instead of adding a suppression mechanism for a defect that
// does not reproduce. If an ancestor ever starts rendering its own hint alongside a descendant's, this fails.
test("#528: only the INNERMOST block shows an entry affordance (no ancestor hint alongside it)", async ({ page }) => {
  await openScratch(page, `aff528i-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(NESTED);
  await sleep(600);
  await page.getByText("inner body text", { exact: false }).first().click();
  await sleep(600);

  const report = await page.evaluate(() => {
    const visible = (e: HTMLElement) => {
      const c = getComputedStyle(e);
      return c.display !== "none" && c.visibility !== "hidden" && parseFloat(c.opacity || "1") > 0.01;
    };
    const hints = [...document.querySelectorAll<HTMLElement>(".cm-lp-macro-edit")].filter(visible);
    // an ancestor pair = two visible entry affordances where one lives inside the other's wrap
    const wrapOf = (e: HTMLElement) => e.closest(".cm-lp-macro-wrap");
    const pairs: string[] = [];
    for (const a of hints) {
      for (const b of hints) {
        if (a === b) continue;
        const wa = wrapOf(a);
        if (wa && wa !== wrapOf(b) && wa.contains(b)) pairs.push(`${a.dataset.testid ?? "?"} ⊃ ${b.dataset.testid ?? "?"}`);
      }
    }
    return { count: hints.length, pairs };
  });

  expect(report.count, "the innermost block does offer an entry affordance").toBeGreaterThan(0);
  expect(report.pairs, "an ancestor must not show its own entry affordance while a descendant shows one").toEqual([]);
});

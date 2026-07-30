import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #528 / ADR-192: one layout owner for every block affordance. The pin is the PROPERTY the ticket asks for
// no two visible affordances of a block overlap — measured the way the collision was found (#528)
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

// A TOP-LEVEL macro is what puts two affordances of the SAME block on screen at once — its chrome row and
// its raw-entry pill. That is the collision this ticket exists for (#528measured it at 8px). The
// nested fixture above no longer produces it, and for the right reason: since #528only the focused
// block shows chrome, so with the caret in the inner note the container's row is correctly gone.
const TOPLEVEL = `:::note[Top]
top body text
:::

after the block
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
  await page.keyboard.insertText(TOPLEVEL);
  await sleep(600);

  // put the caret on the block — the state that makes both of ITS affordances visible at once
  await page.getByText("top body text", { exact: false }).first().click();
  await sleep(500);

  const rects = await visibleAffordances(page);
  // The scenario must still produce chrome — a fixture that renders nothing would pass this test by
  // showing nothing at all.
  expect(rects.length, `the block offers an affordance, saw ${JSON.stringify(rects)}`).toBeGreaterThanOrEqual(1);
  // NOTE (#528): the pair that used to collide here — a nested block's raw pill and the CONTAINER's
  // chrome row, 8px apart — can no longer both be on screen, because only the focused block shows chrome.
  // The collision is prevented by suppression now rather than by displacement, and the pin for that is the
  // ownership test below; this one still guards the geometry for every state where two DO coexist
  // (presence + chrome, or any affordance added later).

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
  await page.keyboard.insertText(TOPLEVEL);
  await sleep(600);
  await page.getByText("top body text", { exact: false }).first().click();
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

// #528①: the collision came BACK while the pointer moved. The owner wrote an inline transform, and
// a hover-gated affordance re-mounts as the pointer crosses it — CodeMirror rebuilds the widget, the inline
// style goes with it, and nothing re-measured because the triggers were only pointerover/transitionend.
// Measured on the rejection: at rest the pill sat at 255..272 (clear); mid-move it read `transform: none`
// at 295..312 and overlapped the ✎ row at 283..302 by 7px. So the pin moves the mouse.
// STILL FAILING, deliberately marked rather than deleted or weakened. The owner now survives the widget
// rebuild — placement is a CSS variable on a node the rebuild does not touch, so "lost its displacement"
// no longer fires — but roughly every other sampled frame still shows the pair 8px apart while the pointer
// crosses the block. Reading of the remaining gap: a pass that sees only ONE affordance (the row is mid-
// rebuild) has nothing to resolve and leaves the variable at its previous value, which is wrong for the
// geometry the row comes back with. The fix is to keep placing from the block's own rectangle rather than
// from whichever affordances happen to be in the DOM at that instant. Marked fixme so the failure is a
// recorded defect instead of a permanently red suite (#528①).
test("#528the affordances stay apart WHILE the pointer moves", async ({ page }) => {
  await openScratch(page, `aff528m-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(TOPLEVEL);
  await sleep(600);
  await page.getByText("top body text", { exact: false }).first().click();
  await sleep(500);

  const box = await page.getByText("top body text", { exact: false }).first().boundingBox();
  expect(box, "the macro is on screen").not.toBeNull();

  // Sample the DISPLACEMENT, not just the overlap. Filtering on visibility hides the very frames that
  // matter: mid-remount the element can be transparent for a tick, so an overlap check quietly skips it and
  // then the flicker the user reported never shows up in the measurement. What the report describes is the
  // owner's transform being wiped (`transform: none` on an element the owner had displaced), so that is
  // what gets asserted — and the overlap is checked too, on whatever is on screen at the time.
  const lost: string[] = [];
  const collisions: string[] = [];
  for (let step = 0; step < 12; step++) {
    await page.mouse.move(box!.x + 8 + step * 10, box!.y - 8 + (step % 4) * 6);
    await sleep(80);
    const frame = await page.evaluate((sel) => {
      const out: { cls: string; transform: string; top: number; bottom: number; left: number; right: number; shown: boolean }[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        out.push({
          cls: el.className,
          transform: cs.transform,
          top: r.top, bottom: r.bottom, left: r.left, right: r.right,
          shown: cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.01,
        });
      }
      return out;
    }, AFFORDANCE_SEL);

    // The pill is the one the owner displaces (the ✎ row keeps its own place). If it is on screen and the
    // owner had moved it, a `none` transform means the inline style was wiped and nothing re-measured.
    const pill = frame.find((f) => f.cls.includes("cm-lp-macro-richui-raw"));
    const row = frame.find((f) => f.cls.includes("cm-lp-macro-btnrow"));
    if (pill && row && pill.shown && row.shown && pill.transform === "none") {
      const overlapping = pill.left < row.right && row.left < pill.right && pill.top < row.bottom && row.top < pill.bottom;
      lost.push(`step ${step}: pill lost its displacement (overlapping=${overlapping})`);
    }
    const shownRects = frame.filter((f) => f.shown);
    for (let i = 0; i < shownRects.length; i++) {
      for (let j = i + 1; j < shownRects.length; j++) {
        const a = shownRects[i]!, b = shownRects[j]!;
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
          collisions.push(`step ${step}: ${a.cls} × ${b.cls} (${Math.round(Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))}px)`);
        }
      }
    }
  }
  expect(lost, "the owner's placement must survive the pointer moving over the block").toEqual([]);
  expect(collisions, "no overlap at any point during the movement").toEqual([]);
});

// #528measured by the user and it overturned the earlier "innermost-only already holds" report
// that check counted VISIBLE affordances without asking which block each belonged to. With the caret in the
// inner :::note, the affordance on screen belonged to the parent columns, and an unrelated tabs block showed
// a permanent ✎ as well. The rule: exactly one block offers an entry affordance — the focused one.
test("#528only the FOCUSED block offers an affordance (asserted by ownership, not by count)", async ({ page }) => {
  await openScratch(page, `aff528f-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`${NESTED}\n::::tabs\n:::tab[One]\nunrelated tab body\n:::\n::::\n\nend\n`);
  await sleep(700);
  await page.getByText("inner body text", { exact: false }).first().click();
  await sleep(600);

  // #528rewrote this check. The previous version decided which block was "focused" by looking at
  // `.cm-lp-macro-wrap` alone — the same assumption the implementation had — so it agreed with the bug and
  // stayed green while the user measured the container lit up and an unrelated block presenting chrome. A
  // macro nested in a layout container HAS NO WRAP: it is the `[data-mac-pos]` slot. The three signals the
  // rejection asked to be read TOGETHER are read together here: ownership, the focus mark, and opacity.
  const report = await page.evaluate(() => {
    const visible = (e: HTMLElement) => {
      const c = getComputedStyle(e);
      return c.display !== "none" && c.visibility !== "hidden" && parseFloat(c.opacity || "1") > 0.01;
    };
    const cursor = document.querySelector<HTMLElement>(".cm-cursor-primary, .cm-cursor");
    // the block the caret is in, taken from DOM ancestry (no geometry, no wrap assumption)
    // A nested macro being edited has NO slot in the document — `mountNestedEditIsland` replaces it with the
    // island — so the island counts as the block here just as it does in the owner.
    const holder = cursor?.parentElement?.closest<HTMLElement>(
      "[data-mac-pos], .cm-lp-slot-edit-island, .cm-lp-nested-edit-island, .cm-lp-macro-wrap",
    ) ?? null;
    const containerOfHolder = holder?.parentElement?.closest<HTMLElement>(".cm-lp-macro-wrap") ?? null;
    const marked = [...document.querySelectorAll<HTMLElement>(".cm-aff-focus")];
    const strayChrome = [...document.querySelectorAll<HTMLElement>(".cm-lp-macro-btnrow, .cm-lp-macro-richui-raw")]
      .filter(visible)
      .filter((el) => !(holder && holder.contains(el)))
      .map((el) => `${el.className} @${Math.round(el.getBoundingClientRect().top)}`);
    return {
      holderIsNested: !!holder && (holder.hasAttribute("data-mac-pos") || !holder.classList.contains("cm-lp-macro-wrap")),
      containerMarked: !!containerOfHolder?.classList.contains("cm-aff-focus"),
      markedCount: marked.length,
      markedIsHolder: marked.length === 1 && marked[0] === holder,
      strayChrome,
    };
  });

  // the caret really is inside a NESTED macro (else the scenario the user reported is not reproduced)
  expect(report.holderIsNested, "the fixture puts the caret in a nested macro (slot or its edit island)").toBe(true);
  // …and the container it lives in is not the one wearing the focus mark (#528measured it was)
  expect(report.containerMarked, "the container must not be focused while its child holds the caret").toBe(false);
  expect(report.markedCount, "exactly one block is focused").toBe(1);
  expect(report.markedIsHolder, "the focused block is the one holding the caret").toBe(true);
  // no chrome anywhere else on screen — the unrelated tabs block included (its row used to sit at opacity 1)
  expect(report.strayChrome, "no block but the focused one shows chrome").toEqual([]);
});

// #528②: the raw pill and the rendered block's ✎ row were the same size, the same corner and the
// same glyph, so a user could not tell which was which. They do different things — one enters the rich
// editor from the source, the other edits the rendered block — so each carries its own tooltip and its own
// mark. This pins that they are distinguishable, not that they look any particular way.
// #556/#528 re-aim: the fixture used to click the nested note's body and expect BOTH affordances
// in that one state — a shape that predates the current entry contracts (since #556 the click lands the
// island caret in the note, which reveals it raw: the RAW pill shows and the rendered pencil is gone; on
// the pre-#556 master the same click revealed neither). The pin's intent ("the two entry affordances are
// told apart") stands; each is now read off the state it actually lives in — the rendered block's ✎
// BEFORE entry, the raw pill AFTER — and the two must still differ in words and glyph.
test("#528the two entry affordances are told apart", async ({ page }) => {
  await openScratch(page, `aff528d-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(NESTED);
  await sleep(800);

  // 1. the rendered block's own ✎, where it lives: the RENDERED nested note (hover-gated — existence
  // and wording are the contract here; visibility gating has its own pins above)
  const rows = await page.evaluate(() => {
    const list = [...document.querySelectorAll<HTMLElement>(".cm-lp-macro-edit, .cm-lp-callout-panel-edit")]
      .filter((e) => !e.classList.contains("cm-lp-macro-richui-raw"));
    return list.map((r) => ({ tip: r.dataset.tip ?? "", svg: r.querySelector("svg")?.innerHTML ?? "" }));
  });
  expect(rows.length, "the rendered block offers its own control").toBeGreaterThan(0);
  expect(rows.every((r) => r.tip.length > 0), "each control names what it does").toBe(true);

  // 2. the RAW pill, where it lives: enter the note (the click reveals its source, #556 top-level parity)
  await page.getByText("inner body text", { exact: false }).first().click();
  await sleep(600);
  const pill = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".cm-lp-macro-richui-raw");
    return el ? { tip: el.dataset.tip ?? "", svg: el.querySelector("svg")?.innerHTML ?? "" } : null;
  });
  expect(pill, "the revealed source offers the raw pill").not.toBeNull();
  expect(pill!.tip, "the pill names what it does").toBeTruthy();

  expect(rows.map((r) => r.tip), "the pencil's words are not the pill's").not.toContain(pill!.tip);
  if (pill!.svg && rows.some((r) => r.svg.length > 0)) {
    expect(rows.filter((r) => r.svg.length > 0).map((r) => r.svg), "nor the same glyph").not.toContain(pill!.svg);
  }
});

// #528(user rejection, measured): hovering a macro showed chrome that came and went with the
// pointer at rest — sampled 8× at 250ms, the visible set alternated between {row, ✎} and {}. Traced in a
// real browser: the pointer was over a NESTED macro, focus (correctly) went to the slot, the container's
// chrome was (correctly) suppressed — and in Live mode the slot had nothing of its own to show, because
// the nested ✎ existed only in WYSIWYG and was hover-CSS-gated besides. The block the user was pointing
// at offered nothing, and every twitch across the container margin made the container chrome pop back
// . Two fixes pinned here: the focused slot's own pencil exists in Live
// and is owner-gated, and the set is STABLE while the pointer rests (the async nested-diagram swap used to
// wipe the pencil ~1.4s in — md-render replaced the slot's children wholesale).
test("#528a nested macro under the pointer offers ITS OWN affordance, steadily", async ({ page }) => {
  await openScratch(page, `aff528s-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(NESTED);
  await sleep(700);

  // hover, no caret: the caret sits in the tail line, so focus is decided by the pointer alone
  await page.getByText("inner body text", { exact: false }).first().hover();
  await sleep(600);

  const samples: { key: string; entries: { ownsHoveredBlock: boolean; top: number }[] }[] = [];
  for (let i = 0; i < 8; i++) {
    samples.push(
      await page.evaluate(() => {
        const visible = (e: HTMLElement) => {
          const c = getComputedStyle(e);
          return c.display !== "none" && c.visibility !== "hidden" && parseFloat(c.opacity || "1") > 0.01;
        };
        const hovered = [...document.querySelectorAll<HTMLElement>("[data-mac-pos]")]
          .find((el) => el.textContent?.includes("inner body text")) ?? null;
        const entries = [...document.querySelectorAll<HTMLElement>(".cm-lp-macro-edit, .cm-lp-macro-btnrow, .cm-lp-macro-richui-raw")]
          .filter(visible)
          // the ✎ inside the chrome row IS the row's content — one control, not two (theprobe
          // measured them as an "overlap"; a container and its child always intersect)
          .filter((e) => !e.closest(".cm-lp-macro-btnrow") || e.classList.contains("cm-lp-macro-btnrow"))
          .map((e) => ({
            // the affordance's host must be the same NODE as the hovered block's host — asserted by
            // identity, not by testid naming (the note's slot renders as a callout panel, and pinning
            // the label would re-break every time a renderer renames itself)
            ownsHoveredBlock: (e.closest("[data-mac-pos]") ?? e.closest(".cm-lp-macro-wrap"))
              === (hovered?.closest("[data-mac-pos]") ?? null),
            top: Math.round(e.getBoundingClientRect().top),
          }));
        return { key: JSON.stringify(entries.map((x) => `${x.ownsHoveredBlock}@${x.top}`).sort()), entries };
      }),
    );
    await sleep(250);
  }

  // stable: the pointer did not move, so neither may the affordance set (red-check: distinct = 1)
  const distinct = new Set(samples.map((s) => s.key));
  expect([...distinct], "the visible set holds still while the pointer rests").toHaveLength(1);
  // one affordance, and it belongs to the block under the pointer — not the container, not a neighbour
  const entries = samples[0]!.entries;
  expect(entries.length, `the hovered nested macro offers a way in, saw ${samples[0]!.key}`).toBeGreaterThanOrEqual(1);
  for (const e of entries) {
    expect(e.ownsHoveredBlock, "every visible affordance belongs to the hovered nested block").toBe(true);
  }
});

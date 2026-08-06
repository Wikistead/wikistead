import { test, expect } from "@playwright/test";
import { openDemo, openScratch, enterEdit, sleep } from "../helpers";

// #632 (user ruling, 2026-08-05): " AI ".
//
// A coloured bar down the left of a box with rounded corners curves inward at both ends. Six places had
// grown the same idiom. The assertion is about the SHAPE, not about those six: any element with a
// rounded left edge AND a coloured left bar is the defect, so a seventh written tomorrow fails the day
// it lands. Naming today's six would pass while the pattern spread.
//
// "Coloured" matters — a plain 1px border in the border token is not a bar, it is a box, and boxes are
// allowed to be round. What the ruling objects to is the accent stripe.
async function curvedBars(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("*")]
      .map((el) => {
        const cs = getComputedStyle(el);
        const px = (v: string) => parseFloat(v) || 0;
        // A left bar is either a thick left border or an inset shadow cast to the right. The computed
        // form puts the keyword LAST — `rgb(9, 105, 218) 2px 0px 0px 0px inset` — so the first offset is
        // read positionally rather than by looking for "inset <n>". Measured: matching the authored
        // order found nothing, and restoring the very bar this ticket removed left the pin green.
        const borderBar = px(cs.borderLeftWidth) >= 2;
        // …and `box-shadow` is a LIST. Tailwind's ring/shadow utilities stack four transparent zeroes in
        // front of the real one, so reading the first offset in the whole string measured a shadow that
        // is not there. Split, then look only at the segment that says `inset`. Measured: without the
        // split, restoring the exact bar this ticket removes left the pin green.
        const shadowBar = cs.boxShadow.split(/,(?![^(]*\))/).some((part) => {
          if (!part.includes("inset")) return false;
          const offsets = part.match(/(-?[\d.]+)px/g) ?? [];
          return px(offsets[0] ?? "0") >= 2;
        });
        if (!borderBar && !shadowBar) return null;
        const roundedLeft = px(cs.borderTopLeftRadius) > 0 || px(cs.borderBottomLeftRadius) > 0;
        if (!roundedLeft) return null;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return null;
        return {
          tag: el.tagName.toLowerCase(),
          testid: el.dataset.testid ?? "",
          cls: el.className.toString().slice(0, 60),
          borderLeft: cs.borderLeftWidth + " " + cs.borderLeftColor,
          shadow: cs.boxShadow.slice(0, 60),
          radius: `${cs.borderTopLeftRadius}/${cs.borderBottomLeftRadius}`,
        };
      })
      .filter(Boolean));
}

for (const [name, path] of [["settings", "/admin/members"], ["login", "/"], ["space settings", "/spaces/demo_space/settings/members"]] as const) {
  test(`#632: no curved left bar on ${name}`, async ({ page }) => {
    await openDemo(page);
    await page.goto(path);
    await sleep(1200);
    const found = await curvedBars(page);
    expect(found, `a coloured left bar against a rounded left edge: ${JSON.stringify(found)}`).toEqual([]);
  });
}

// #632 (user ruling, after): every macro that draws a left bar, rendered and measured.
//
// The earlier version of this file rendered ONE callout, so `:::todo` shipped bent and the pin stayed
// green — the exact failurenames (" pin ").
// The sources come from the registry via a unit-side list, so a macro registered next month is drawn
// here without this file being edited.
//
// What is measured is the BEND, not the corners. The ruling is explicit that the frame may stay round
// , so a rounded box is fine — what must not happen
// is the bar following that curve. A `border-left` always does; an absolutely-positioned strip never
// does. So the check is: anything that looks like a left bar must NOT be a border on a rounded box.
const CONTAINER_SOURCES = [
  ":::note\nnote body\n:::",
  ":::info\ninfo body\n:::",
  ":::tip\ntip body\n:::",
  ":::warning\nwarning body\n:::",
  ":::danger\ndanger body\n:::",
  ":::todo\n- [ ] one\n- [ ] two\n:::",
  ":::details[more]\ndetails body\n:::",
];

test("#632: no container macro's bar bends around its frame", async ({ page }) => {
  await openScratch(page, "container-bars-632");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(CONTAINER_SOURCES.join("\n\n") + "\n\ntail\n");
  await sleep(1500);

  const found = await page.evaluate(() => {
    const px = (v: string) => parseFloat(v) || 0;
    const out: { cls: string; why: string }[] = [];
    let barsSeen = 0;
    for (const el of [...document.querySelectorAll<HTMLElement>("[data-pane=preview] *")]) {
      const cs = getComputedStyle(el);
      // "a left bar" = a left border noticeably thicker than the others, or a left-only colour. A plain
      // 1px frame in the border token is a box, not a bar —hit nine false positives by not
      // drawing that line.
      const l = px(cs.borderLeftWidth);
      const others = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth)];
      const thicker = l >= 2 && l > Math.max(...others);
      const leftOnlyColour = l >= 2 && cs.borderLeftColor !== cs.borderTopColor;
      // …and a bar drawn the RIGHT way: a narrow strip pinned to the left edge. Counted so the premise
      // below survives the fix — after it, no bar is a border at all, and a premise that only knew about
      // borders would report "nothing rendered" on a correct page.
      const b = getComputedStyle(el, "::before");
      const strip = b.position === "absolute" && px(b.width) >= 2 && px(b.width) <= 6 && b.left === "0px";
      if (strip) barsSeen++;
      if (!thicker && !leftOnlyColour) continue;
      barsSeen++;
      const rounded = px(cs.borderTopLeftRadius) > 0 || px(cs.borderBottomLeftRadius) > 0;
      if (rounded) out.push({ cls: el.className.toString().slice(0, 60), why: `border ${cs.borderLeftWidth} on a radius ${cs.borderTopLeftRadius}/${cs.borderBottomLeftRadius}` });
    }
    return { out, barsSeen };
  });

  // the premise: bars were actually drawn. Without this the assertion below passes on a blank page,
  // which is how the previous version of this pin stayed green while `:::todo` was bent.
  expect(found.barsSeen, "the fixture rendered elements that carry a left bar").toBeGreaterThan(0);
  expect(found.out, `a bar drawn as a border on a rounded frame will bend: ${JSON.stringify(found.out)}`).toEqual([]);
});

// #632 (user ruling): the strip replaced a border, and a border occupied space that a strip does
// not. Whatever the bar is drawn with, the content behind it has to start in the same place — the ruling
// is explicit that " 3px ".
//
// This shipped wrong once BECAUSE nobody compared: the panel and the Tailwind boxes each got the 3px
// added back to their padding, and the CM baseTheme rule did not, so `:::todo`'s icon and body slid 3px
// left.
//
// "The padding reserves at least the strip's width" is the obvious check and it is worthless here — the
// gutter is 2.8em, so it clears a 3px strip by a mile whether or not anyone compensated. What has to be
// true is stronger: the padding must be DERIVED from the bar's width. So the bar's width is a token, and
// this widens it at runtime and watches: every element that draws a strip must move its content by
// exactly as much as the strip grew. A site that hard-codes its padding does not move, and fails.
//
// That is why this pin needs no table of remembered numbers and names no implementation — a fourth strip
// written next month is measured the same way, and the todo regression is caught at its own site.
test("#632: a strip does not eat into the space the border used to hold", async ({ page }) => {
  await openScratch(page, "container-bars-632-c");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(CONTAINER_SOURCES.join("\n\n") + "\n\ntail\n");
  await sleep(1500);

  const GROW = 10;
  const measured = await page.evaluate((grow) => {
    const px = (v: string) => parseFloat(v) || 0;
    const bars = () => {
      const out = new Map<HTMLElement, { strip: number; padLeft: number }>();
      for (const el of [...document.querySelectorAll<HTMLElement>("[data-pane=preview] *")]) {
        const b = getComputedStyle(el, "::before");
        if (b.position !== "absolute" || b.left !== "0px") continue;
        const w = px(b.width);
        if (w < 2 || w > 6 + grow) continue;
        out.set(el, { strip: w, padLeft: px(getComputedStyle(el).paddingLeft) });
      }
      return out;
    };
    const before = bars();
    document.documentElement.style.setProperty("--wks-bar-w", `${3 + grow}px`);
    const after = bars();
    document.documentElement.style.removeProperty("--wks-bar-w");
    return [...before].map(([el, b]) => ({
      cls: el.className.toString().slice(0, 50),
      stripGrew: (after.get(el)?.strip ?? b.strip) - b.strip,
      padGrew: (after.get(el)?.padLeft ?? b.padLeft) - b.padLeft,
    }));
  }, GROW);

  expect(measured.length, "the fixture rendered elements that draw a strip").toBeGreaterThan(0);
  for (const m of measured) {
    expect(m.stripGrew, `${m.cls}: draws its bar from the shared width token`).toBeCloseTo(GROW, 0);
    expect(m.padGrew, `${m.cls}: reserves the bar's width — its content moved ${m.padGrew}px when the bar grew ${GROW}px`)
      .toBeCloseTo(GROW, 0);
  }
});

// #632and the same has to hold for what the padding CANNOT move. Padding pushes flow content;
// an absolutely-positioned child ignores it entirely. So when the coloured border became a strip, the
// compensation put `:::todo`'s body back and left its icon three pixels behind — nearer the strip, further
// from the words it labels. The panel-shaped callout was untouched, which is why measuring one shape says
// nothing about the other: its icon hangs off the label, a flex child, and travels with the padding.
//
// Same instrument as above rather than a remembered coordinate: widen the token and watch. Anything
// absolutely placed inside a strip-bearing box must move with the strip, or it is positioned from a
// literal that will drift the next time the strip changes.
test("#632: what the padding cannot move is placed from the bar's width too", async ({ page }) => {
  await openScratch(page, "container-bars-632-d");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(CONTAINER_SOURCES.join("\n\n") + "\n\ntail\n");
  await sleep(1500);

  const GROW = 10;
  const measured = await page.evaluate((grow) => {
    // every box that draws a strip, and every absolutely-placed thing inside it, by offset from the box
    const placed = () => {
      const out: { key: string; dx: number }[] = [];
      for (const el of [...document.querySelectorAll<HTMLElement>("[data-pane=preview] *")]) {
        const b = getComputedStyle(el, "::before");
        if (b.position !== "absolute" || b.left !== "0px") continue;
        const w = parseFloat(b.width) || 0;
        if (w < 2 || w > 6 + grow) continue;
        const box = el.getBoundingClientRect();
        for (const kid of [...el.querySelectorAll<HTMLElement>("*")]) {
          const cs = getComputedStyle(kid);
          if (cs.position !== "absolute") continue;
          // Which of these belong to the left gutter is a question about GEOMETRY, not about how the rule
          // was written: for a positioned element Chrome resolves `left` to a used value, so the todo
          // ring — anchored `right: 0.7em` — reports a number and not `auto`. Reading the declaration
          // would have called it a left-placed child and demanded it track a strip at the other end.
          //
          // So: in the gutter means the child ends before the content does. That excludes the ring, and
          // it excludes `left: 0`, which is flush to the edge ON PURPOSE (#424 pins every edit affordance
          // to the block's left edge, deliberately over whatever decorates it).
          const k = kid.getBoundingClientRect();
          const padLeft = parseFloat(getComputedStyle(el).paddingLeft) || 0;
          if (parseFloat(cs.left) === 0 || k.right > box.left + padLeft + 1) continue;
          const cls = `${el.className.toString().split(/\s+/).slice(-1)[0]} > ${kid.className.toString().split(/\s+/)[0]}`;
          out.push({ key: cls, dx: kid.getBoundingClientRect().left - box.left });
        }
      }
      return out;
    };
    const before = placed();
    document.documentElement.style.setProperty("--wks-bar-w", `${3 + grow}px`);
    const after = placed();
    document.documentElement.style.removeProperty("--wks-bar-w");
    return before.map((b, i) => ({ key: b.key, moved: (after[i]?.dx ?? b.dx) - b.dx }));
  }, GROW);

  expect(measured.length, "the fixture drew a strip box with something absolutely placed in it").toBeGreaterThan(0);
  for (const m of measured) {
    expect(m.moved, `${m.key}: placed from the bar's width — it moved ${m.moved}px when the bar grew ${GROW}px`)
      .toBeCloseTo(GROW, 0);
  }
});

test("#632: the bar is still there, still 3px, still the type's colour", async ({ page }) => {
  // Removing the border would satisfy the test above by deleting the bar, which the ruling refused
  // outright . So the strip is measured for real, on the widest-known types.
  await openScratch(page, "container-bars-632-b");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::warning\nheads up\n:::\n\n:::todo\n- [ ] a\n:::\n\ntail\n");
  await sleep(1500);

  const strips = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-pane=preview] .cm-lp-callout")].slice(0, 4).map((el) => {
      const before = getComputedStyle(el, "::before");
      return { cls: el.className.slice(0, 40), w: before.width, bg: before.backgroundColor, pos: before.position };
    }));
  expect(strips.length, "callout containers rendered").toBeGreaterThan(0);
  for (const s of strips) {
    expect(parseFloat(s.w), `${s.cls}: the bar is still 3px`).toBeCloseTo(3, 0);
    expect(s.bg, `${s.cls}: and still carries a colour`).not.toBe("rgba(0, 0, 0, 0)");
    expect(s.pos, `${s.cls}: drawn absolutely, so the frame's radius cannot bend it`).toBe("absolute");
  }
});

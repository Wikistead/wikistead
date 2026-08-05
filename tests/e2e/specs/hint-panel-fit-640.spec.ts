import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #640: nothing inside a floating explanation reaches past the box that draws it.
//
// The defect was 220px written twice — once as the panel's width (`HINT_PANEL_W`) and once on the content
// inside it (`RoleTip`). The panel's CONTENT area is 220 minus `px-2` minus the border, so the inner div
// was 18px too wide on every surface that raises it, and `overflow: visible` showed the rest.
//
// #582's overflow pin did not see it: that one measures TEXT wrapping (a leaf whose `scrollWidth` exceeds
// its own `clientWidth`). A child that is simply wider than its parent is a different shape, and it needs
// its own question — asked of every panel the app raises, not of the five known screens.
const SCREENS = [
  { name: "roles", url: "/admin/roles" },
  { name: "tenant members", url: "/admin/members" },
  { name: "space members", url: "/spaces/demo_space/settings/members" },
];

type Spill = { where: string; testid: string | null; child: string; over: number };

/** Hover every `cursor: help` trigger and measure what appears against the box that draws it. */
async function spillsOn(page: Page, where: string): Promise<{ spills: Spill[]; kinds: string[] }> {
  // The hand-placed panels (`Select`'s hint, the group mark) are raised by hovering a CONTROL, not a
  // `cursor: help` word — and those are the panels that carry `HINT_PANEL_W`, which is to say the ones
  // this ticket is about. A walk that only finds the Radix ones measures the half that was never broken.
  const triggers = page.locator(
    "css=[class*=cursor-help], [data-testid=group-role-name], [data-testid=group-roles-mark], " +
    "[data-testid$=-role-select], [data-testid$=-capability-select], [data-testid=grant-relation]");
  const n = Math.min(await triggers.count(), 8);
  const out: Spill[] = [];
  const kinds = new Set<string>();
  for (let i = 0; i < n; i++) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    await t.scrollIntoViewIfNeeded().catch(() => {});
    const box = await t.boundingBox();
    if (!box) continue;
    await page.mouse.move(box.x - 24, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await page.waitForTimeout(450);
    const seen = await page.evaluate((w) => {
      const found: { where: string; testid: string | null; child: string; over: number }[] = [];
      const met = new Set<string>();
      // the boxes that DRAW a floating explanation, however they were built
      // The BOX, which is what has the width and the padding. `data-role-panel` marks the CONTENT (the
      // capability list), so a walk that only collected those measured the inner div against itself and
      // never saw it overflow the panel around it — the defect this ticket is about, invisible.
      const panels = [...document.querySelectorAll<HTMLElement>(
        "[data-testid$=-hint], [data-testid=select-hint], [data-testid=group-roles-list], [data-slot=tooltip-content]")]
        // the accessibility mirror is a clipped copy — it is not on screen and its geometry is not a defect
        .filter((e) => !e.closest('[role=tooltip][style*="clip"]'))
        .filter((e) => e.getBoundingClientRect().width > 1);
      for (const p of panels) {
        // `radix` sizes to its content; `placed` carries the shared fixed width — the kind this ticket broke
        met.add(p.getAttribute('data-slot') === 'tooltip-content' ? 'radix' : 'placed');
        const r = p.getBoundingClientRect();
        const cs = getComputedStyle(p);
        // the CONTENT box: what is left after the border and the padding, which is the room a child has
        const left = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
        const right = r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
        for (const kid of p.querySelectorAll<HTMLElement>("*")) {
          // Radix draws the pointer as an svg that sticks out of the panel ON PURPOSE — and wraps it in a
          // span, so excluding the svg alone leaves its container reporting the same 14px.
          if (kid.closest("svg") || kid.tagName.toLowerCase() === "svg") continue;
          if (kid.hasAttribute("data-radix-popper-arrow") || kid.querySelector("svg")) continue;
          // the accessibility mirror again — it is inside the panel, clipped to nothing, and its position
          // is not something a reader can see. Excluded at the PANEL above and here, at the child.
          if (kid.closest('[role=tooltip][style*="clip"]')) continue;
          const k = kid.getBoundingClientRect();
          if (k.width === 0) continue;
          const over = Math.round(Math.max(k.right - right, left - k.left));
          if (over > 1) {
            found.push({
              where: w,
              testid: p.getAttribute("data-testid") ?? p.getAttribute("data-slot"),
              child: `${kid.tagName.toLowerCase()}.${kid.className?.toString().slice(0, 40)}`,
              over,
            });
          }
        }
      }
      return { found, met: [...met] };
    }, where);
    out.push(...seen.found);
    for (const k of seen.met) kinds.add(k);
    await page.mouse.move(4, 4);
    await page.waitForTimeout(200);
  }
  return { spills: out, kinds: [...kinds] };
}

for (const lang of ["en", "ja"]) {
  test(`#640: nothing inside a hint panel reaches past its box (${lang})`, async ({ page }) => {
    test.setTimeout(180_000);
    // ja packs more into the same width, so a fit that holds in English can fail here — the reject asked
    // for both explicitly.
    await page.addInitScript((l) => { try { localStorage.setItem("wks.lang", l); } catch { /* private mode */ } }, lang);
    await openDemo(page);

    const spills: Spill[] = [];
    let panels = 0;
    const kinds = new Set<string>();
    for (const s of SCREENS) {
      await page.goto(s.url);
      await page.waitForTimeout(1200);
      const found = await spillsOn(page, s.name);
      spills.push(...found.spills);
      for (const k of found.kinds) kinds.add(k);
      panels += await page.evaluate(() =>
        document.querySelectorAll("[data-role-panel], [data-slot=tooltip-content]").length);
    }
    // the walk reached panels at all — without this the check is true of a page with none
    expect(panels, "the walk raised panels to measure").toBeGreaterThan(0);
    // …and reached the HAND-PLACED kind, which is where the duplicated width lived. Without this the
    // check passes on Radix panels alone, which size to their content and never showed the defect.
    expect([...kinds], `the walk only met one kind of panel :: ${JSON.stringify([...kinds])}`).toContain("placed");
    expect(spills, `content reaching past its panel :: ${JSON.stringify(spills)}`).toEqual([]);
  });
}

test("#640: the panel's width is declared in one place", async () => {
  // The geometry check above is the real one; this says WHY it broke, so the next person does not write
  // the number a second time. The width belongs to the panel (`HINT_PANEL_W`) and the content sizes to it.
  const { readFileSync, readdirSync } = await import("node:fs");
  const { resolve, join } = await import("node:path");
  const SRC = resolve(import.meta.dirname, "..", "..", "..", "apps", "web", "src");
  const width = /w-\[220px\]/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.tsx?$/.test(e.name)) continue;
      if (e.name === "hint-panel.ts") continue; // the one place it belongs
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (width.test(line) && !line.trimStart().startsWith("//")) offenders.push(`${e.name}:${i + 1}`);
      });
    }
  };
  walk(SRC);
  expect(offenders, `the panel width is written outside hint-panel.ts: ${offenders.join(", ")}`).toEqual([]);
});

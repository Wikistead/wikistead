import { test, expect, type Page } from "@playwright/test";

// #582 (review rejection,/): the floating explanation panels, measured as a FAMILY.
//
// Three complaints, one subject. Only the Radix-backed one animated, so a reader saw one panel ease in
// while its siblings appeared instantly. Text ran outside the fill (measured: scrollWidth 228 in a
// 220px box, on every row). And a panel could sit off the screen — the second tier off the right at a
// 1000px window, the first tier off the bottom at a 420px one.
//
// Discovery inside each screen, because the family is what matters: every trigger is found by the
// affordance they share (`cursor: help`), hovered, and whatever panel appears is measured. Adding a
// seventh surface to a listed screen is covered without touching this file; the screens themselves are
// listed only because a spec has to navigate somewhere.
const SCREENS = [
  { name: "roles", url: "/admin/roles" },
  { name: "space members", url: "/spaces/demo_space/settings/members" },
  { name: "tenant members", url: "/admin/members" },
];

type Panel = { testid: string | null; overflow: number; inViewport: boolean; animation: string; where: string };

/** Hover each `cursor: help` trigger on the page and report every panel that appears. */
async function walkPanels(page: Page, where: string): Promise<Panel[]> {
  const triggers = page.locator("css=[class*=cursor-help], [data-testid=group-role-name]");
  const n = Math.min(await triggers.count(), 8);
  const seen: Panel[] = [];
  for (let i = 0; i < n; i++) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    const box = await t.boundingBox();
    if (!box) continue;
    // progressive movement: a teleporting pointer is the measurement trap this repo has hit twice
    await page.mouse.move(box.x - 30, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await page.waitForTimeout(400);
    seen.push(...await page.evaluate((w) => {
      // the FAMILY, named by the product (`data-role-panel`), measured at its BOX — the panel that
      // paints is the tooltip/portal wrapper around that content, and it is the box that can spill or
      // leave the screen. Inferring the family from a shared affordance swept up a status icon's
      // ordinary label, which animates by design and has nothing to do with this ruling.
      return [...document.querySelectorAll<HTMLElement>("[data-role-panel]")]
        .map((c) => (c.closest("[data-slot=tooltip-content], [role=tooltip]") as HTMLElement) ?? c)
        .filter((p) => p.getBoundingClientRect().width > 0)
        .map((p) => {
          const r = p.getBoundingClientRect();
          return {
            testid: p.getAttribute("data-testid") ?? p.getAttribute("data-slot"),
            overflow: p.scrollWidth - p.clientWidth,
            inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
            animation: getComputedStyle(p).animationName,
            where: w,
          };
        });
    }, where));
    await page.mouse.move(4, 4);
    await page.waitForTimeout(200);
  }
  return seen;
}

test("#582: every role panel agrees on animation", async ({ page }) => {
  test.setTimeout(180_000);
  const all: Panel[] = [];
  for (const s of SCREENS) {
    await page.goto(s.url);
    await page.waitForTimeout(1200);
    all.push(...await walkPanels(page, s.name));
  }
  expect(all.length, `the walk found panels to compare :: ${JSON.stringify(all)}`).toBeGreaterThan(2);

  // ① one family, one behaviour: whatever the animation is, it is the same everywhere
  const animations = [...new Set(all.map((p) => p.animation))];
  expect(animations, `panels disagree on animation :: ${JSON.stringify(all.map((p) => [p.where, p.testid, p.animation]))}`).toHaveLength(1);

  // ⑤ (the fill) and(the viewport) are NOT asserted here yet — see the ticket: the walk still
  // reports offenders on the roles screen that this turn did not get to the bottom of, and an assertion
  // that is green only because it was weakened would be worse than the gap it hides.
});

//(no panel leaves the screen, any tier, small window) is measured but NOT yet pinned: the walk
// finds escapes on /admin/roles at 1280x420 that this turn did not close. Reported on the ticket with
// the numbers rather than left here as a red or, worse, as a weakened green.

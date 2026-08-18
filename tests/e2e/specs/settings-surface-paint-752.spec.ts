import { test, expect, type Page } from "@playwright/test";

// #752: a settings pane may not paint a SURFACE with the rail's own colour.
//
// — the owner, at the roles tab, during #735's review. Measured, that tab filled 85% of its pane
// with `bg-panel`, the token the navigation rail is painted in, and the sign-in tab was second at 68%
// across fourteen stacked rows. Every list that draws through the shared `ListBox` painted nothing.
//
// WHY AN E2E: the defect is a fraction of a rendered area. `bg-panel` appears legitimately all over this
// console — on inputs, on option cards, on a segmented control — so counting the token in the source says
// nothing about whether a screen looks heavy, and a unit test with no layout engine cannot tell a
// textarea from a card the size of the window.
//
// ⚠️ A DISCOVERY WALK, like #735's beside it: the tabs come from the rail the app renders. The screen the
// owner objected to was not the screen anybody would have listed, and the one that measured second was
// not in the report at all.

const RAIL = '[data-testid^="settings-tab-"]';

/**
 * FORM CONTROLS ARE EXEMPT, and the exemption is what makes this measurable rather than a matter of
 * taste. A filled input is this design system's input; a filled card the height of the pane is a
 * surface. Measured with the exemption in place: the two offending tabs were 46% and 68%, and the
 * heaviest legitimate case left standing is a segmented control at 4%.
 */
const FORM = ["input", "textarea", "select", "button", "label"];

/** How much of a pane is painted in the rail's colour by things that are not form controls. */
async function paintedFraction(page: Page): Promise<{ pct: number; worst: string } | null> {
  return page.evaluate(({ form }) => {
    const pane = document.querySelector<HTMLElement>("section.overflow-y-auto [data-settings-pane]");
    const rail = document.querySelector<HTMLElement>("nav[aria-label]");
    if (!pane || !rail) return null;
    const railBg = getComputedStyle(rail).backgroundColor;
    const rect = pane.getBoundingClientRect();
    const paneArea = rect.width * Math.max(pane.scrollHeight, rect.height);
    if (!paneArea) return null;
    let painted = 0, largest = 0, worst = "";
    const counted: HTMLElement[] = [];
    for (const el of pane.querySelectorAll<HTMLElement>("*")) {
      if (getComputedStyle(el).backgroundColor !== railBg) continue;
      if (form.includes(el.tagName.toLowerCase())) continue;
      // A painted child of a painted parent is the same paint, counted once.
      if (counted.some((a) => a.contains(el))) continue;
      counted.push(el);
      const rc = el.getBoundingClientRect();
      const a = rc.width * Math.max(rc.height, el.scrollHeight);
      painted += a;
      if (a > largest) { largest = a; worst = `${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 60)}`; }
    }
    return { pct: Math.round((painted / paneArea) * 100), worst };
  }, { form: FORM });
}

test("#752: no settings tab paints a surface in the rail's colour", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1400, height: 900 });

  const heavy: string[] = [];
  let walked = 0;
  for (const root of ["/admin", "/spaces/demo_space/settings/general", "/settings/account"]) {
    await page.goto(root);
    await expect(page.locator(RAIL).first(), `the rail rendered at ${root}`).toBeVisible({ timeout: 30_000 });
    const tabs = await page.locator(RAIL).evaluateAll((els) => els.map((e) => ({
      key: e.getAttribute("data-testid")!.replace("settings-tab-", ""),
      href: (e as HTMLAnchorElement).getAttribute("href")!,
    })));
    for (const { key, href } of tabs) {
      await page.goto(href);
      await page.locator("section.overflow-y-auto [data-settings-pane]").first()
        .waitFor({ state: "attached", timeout: 20_000 }).catch(() => { /* #735's walk owns that failure */ });
      const r = await paintedFraction(page);
      if (!r) continue;
      walked++;
      // 10%: above every legitimate case measured (the segmented control on the theme tab is 4%) and far
      // below both offenders (46% and 68%). A bound picked from measurements, not from comfort.
      if (r.pct > 10) heavy.push(`${root} ${key}: ${r.pct}% — ${r.worst}`);
    }
  }

  // A walk that finds nothing agrees with every possible state of the code (#719's shape).
  expect(walked, "tabs measured").toBeGreaterThan(20);
  expect(heavy, "these tabs paint a surface in the navigation rail's own colour").toEqual([]);
});

import { test, expect, type Page } from "@playwright/test";

// #735: every settings tab sits in the same frame and wears the same heading, measured in a real browser.
//
// WHY THIS IS AN E2E AND NOT A UNIT TEST: the defect was a computed distance — SCIM and custom domains
// rendered flush against the rail at 0px on every side — and a grep for `p-6` cannot see that. Nor can
// happy-dom, which has no layout engine, so `getBoundingClientRect` there returns zeroes for
// everything and would agree with any answer. The ruling on this ticket says to measure the real DOM,
// and this is the only place that exists.
//
// ⚠️ THE WALK IS A DISCOVERY WALK. The tabs come from the rail the app renders — one link per surface
// the SERVER says is open — never from a list of names written here. That distinction is the whole
// point of the ticket: the two broken tabs were BOTH added after the convention existed, and a pin
// naming the tabs it knew about would have been green on the day they shipped. A tab added tomorrow
// with no frame turns this red tomorrow. (It did: the space console was added to the walk in the same
// change that added the heading checks, and the FIRST thing it found was #725's import screen, which
// had shipped a week after the frame moved into the shell and written its own frame anyway.)

const RAIL_TABS = '[data-testid^="settings-tab-"]';

/** The three steps the shell offers, and nothing else (SETTINGS_WIDTHS). */
const TIERS = [560, 720, 920];

type Frame = {
  tab: string;
  left: number;
  top: number;
  width: number;
  tier: string | null;
  /** The heading's computed look, as one comparable string. `null` = the tab drew no heading. */
  heading: string | null;
};

/**
 * The properties that decide whether two headings look like the same heading.
 *
 * Written out rather than diffed wholesale: a full computed-style comparison would also pick up
 * `width` (the pane tiers differ by design) and `inline-size`, so every tab would disagree and the
 * assertion would have to be deleted the first time somebody ran it. These are the ones the eye reads,
 * and they are exactly what was wrong — twelve tabs painted their heading at body size and weight
 * because the Tailwind preflight strips h1-h6 and settings panes sit outside `.wks-prose`, while the
 * two newest wore `text-lg font-semibold`. The owner saw those two as bold, which they were.
 */
const HEADING_PROPS = ["fontSize", "fontWeight", "fontFamily", "lineHeight", "color", "marginTop", "marginBottom"] as const;

/**
 * Measure one tab: the gap between the scrolling section and the content column inside it, and how
 * wide that column is allowed to get.
 *
 * Read off `getBoundingClientRect` rather than the class list, because the class is what was already
 * believed to be right. The pane is found by its DATA ATTRIBUTE, so a tab that renders no pane at all
 * is reported as such instead of silently measuring its first child.
 */
async function measure(page: Page, tab: string): Promise<Frame> {
  return page.evaluate(({ tabKey, headingProps }) => {
    const section = document.querySelector("section.overflow-y-auto");
    const pane = section?.querySelector<HTMLElement>("[data-settings-pane]");
    if (!section || !pane) return { tab: tabKey, left: -1, top: -1, width: -1, tier: null, heading: null };
    const s = section.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    // Found by the attribute the shell writes, never by `h2`: a tab that goes back to hand-writing its
    // own heading has no such node and is reported as headingless, which is the case that let a second
    // format become a third while every check stayed green.
    const h = pane.querySelector<HTMLElement>("[data-settings-heading]");
    const cs = h && getComputedStyle(h);
    return {
      tab: tabKey,
      left: Math.round(p.left - s.left),
      top: Math.round(p.top - s.top),
      // The CAP, not the painted width — a narrow viewport would otherwise report the viewport.
      width: Math.round(parseFloat(getComputedStyle(pane).maxWidth)),
      tier: pane.getAttribute("data-settings-pane"),
      heading: cs ? headingProps.map((k) => `${k}=${cs[k as never]}`).join(" ") : null,
    };
  }, { tabKey: tab, headingProps: [...HEADING_PROPS] });
}

/** Walk whatever the rail is showing, and measure each one. */
async function walk(page: Page, root: string): Promise<Frame[]> {
  await page.goto(root);
  await expect(page.locator(RAIL_TABS).first(), `the rail rendered at ${root}`).toBeVisible({ timeout: 30_000 });
  // The rail IS the registry, as the app renders it — each link's href is where that surface lives.
  const tabs = await page.locator(RAIL_TABS).evaluateAll((els) => els.map((e) => ({
    key: e.getAttribute("data-testid")!.replace("settings-tab-", ""),
    href: (e as HTMLAnchorElement).getAttribute("href")!,
  })));
  expect(tabs.length, `${root} has tabs to walk (a walk that finds nothing agrees with everything)`).toBeGreaterThan(3);

  const out: Frame[] = [];
  for (const { key, href } of tabs) {
    // ⚠️ A FULL NAVIGATION per tab, not a click. Clicking leaves the PREVIOUS tab's pane in the DOM
    // while the next one mounts, so anything that waits for "a pane" — including polling the
    // measurement until it is non-null — is satisfied by the tab we just left, and the walk reports one
    // tab's frame N times as proof that they all agree. Measured: the click version finished in 3.8s
    // where this takes ~25s, which is what measuring the same node twenty times looks like.
    // `goto` throws the old document away, so whatever is measured is this tab's or nothing.
    await page.goto(href);
    await page.locator("section.overflow-y-auto [data-settings-pane]").first()
      .waitFor({ state: "attached", timeout: 20_000 })
      .catch(() => { /* recorded as tier: null below — that IS the defect this walk looks for */ });
    out.push(await measure(page, `${root} ${key}`));
  }
  return out;
}

test("#735: every settings tab has the same frame, one of three widths, and the same heading", async ({ page }) => {
  test.setTimeout(240_000);
  // A wide viewport on purpose: at 920 the widest tier must not be the thing being measured.
  await page.setViewportSize({ width: 1400, height: 900 });

  // All THREE settings consoles, which is what the ruling asked for and what the first round only
  // did two of: a space's own tabs were listed in the acceptance and never walked, and five of them
  // (general, members, pages, trash, moderation) are exactly the surfaces this ticket rewrote. The
  // space id is the seeded demo space rather than a discovered one — the rail INSIDE it is still the
  // registry, so a space tab added tomorrow is walked without anybody editing this line.
  const frames = [
    ...await walk(page, "/admin"),
    ...await walk(page, "/spaces/demo_space/settings/general"),
    ...await walk(page, "/settings/account"),
  ];

  // 0. The walk actually walked. A discovery test that discovers nothing agrees with every possible
  // state of the code, and this repository has shipped that shape before. The three consoles
  // together carry more than twenty-five tabs; a number this far below any real total means a rail
  // did not render, not that the product shrank. Raised with the third console rather than left at
  // the old floor: a bound that a shrunken walk still clears is a bound that stopped working.
  expect(frames.length, `tabs measured: ${frames.map((f) => f.tab).join(", ")}`).toBeGreaterThan(20);

  // 1. Every tab HAS a frame. This is the reported bug in one line: a tab with no pane measures -1.
  const frameless = frames.filter((f) => f.tier === null);
  expect(frameless.map((f) => f.tab), "these tabs render no content column at all").toEqual([]);

  // 2. The gap is the SAME everywhere. Not "close to" — one number, because it comes from one place.
  const lefts = [...new Set(frames.map((f) => f.left))];
  const tops = [...new Set(frames.map((f) => f.top))];
  expect(lefts, `left gaps differ: ${JSON.stringify(frames.map((f) => [f.tab, f.left]))}`).toHaveLength(1);
  expect(tops, `top gaps differ: ${JSON.stringify(frames.map((f) => [f.tab, f.top]))}`).toHaveLength(1);
  // …and it is a real gap, not zero everywhere (which would also be "the same").
  expect(lefts[0], "the gap is nonzero — flush against the rail is the defect, not the fix").toBeGreaterThan(8);
  expect(tops[0], "…and the same above").toBeGreaterThan(8);

  // 3. The width is one of the decided steps. An arbitrary number here means somebody wrote a
  // max-width by hand again, which is how six of them accumulated.
  const strays = frames.filter((f) => !TIERS.includes(f.width));
  expect(strays.map((f) => [f.tab, f.width]), `widths outside ${TIERS.join(" / ")}`).toEqual([]);

  // 4. The step a tab NAMES is the step it WEARS. The attribute and the class are written side by side
  // on ~30 roots, so the pair can drift with one careless copy — and a drifted pair passes every
  // check above (the width is still a legal step, the gap is still right). Only comparing the two
  // catches it, and without this the attribute would be decoration rather than the thing the walk
  // trusts.
  const named: Record<string, number> = { form: 560, list: 720, wide: 920 };
  const mismatched = frames.filter((f) => f.tier !== null && named[f.tier] !== f.width);
  expect(mismatched.map((f) => [f.tab, f.tier, f.width]), "these name one step and wear another").toEqual([]);

  // 5. Every tab HAS a heading, and every heading LOOKS THE SAME. (#735, second round.)
  //
  // The frame was fixed and the same defect came straight back one layer up: fourteen admin tabs
  // spelled their `<h2>` three different ways, and the two written most recently were the only two
  // that looked like headings — which is what the owner saw and what
  // is about. It came back because the first round fixed the fourteen places rather than the reason
  // there were fourteen places.
  //
  // Measured from COMPUTED STYLE, not from the class list. The twelve broken headings all carried a
  // perfectly reasonable-looking `className="mt-0"`; what made them wrong was invisible in the
  // source — the preflight strips h1-h6, these panes render outside `.wks-prose`, and no global
  // heading rule exists — so a source-level check would have called them correct.
  const headless = frames.filter((f) => f.heading === null);
  expect(headless.map((f) => f.tab), "these tabs render no heading the shell drew").toEqual([]);
  const looks = [...new Set(frames.map((f) => f.heading))];
  expect(
    looks,
    `headings differ:\n${frames.map((f) => `  ${f.tab}: ${f.heading}`).join("\n")}`,
  ).toHaveLength(1);
  // …and it reads as a heading rather than as body text, which is the half "they all agree" cannot
  // say: twelve identical body-sized headings would satisfy the line above perfectly.
  const size = parseFloat(looks[0]!.match(/fontSize=([\d.]+)px/)![1]!);
  const weight = parseInt(looks[0]!.match(/fontWeight=(\d+)/)![1]!, 10);
  expect(size, `the heading is larger than the UI text it sits above (${looks[0]})`).toBeGreaterThan(16);
  expect(weight, `…and heavier than body weight (${looks[0]})`).toBeGreaterThan(400);
});

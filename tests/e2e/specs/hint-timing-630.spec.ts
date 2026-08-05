import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #630 (review rejection): the three floating-explanation implementations must AGREE on how long they
// stay after the pointer leaves — measured as time, not as whether they import the same constant.
//
// The reject is about exactly that difference. `Select` imported `HINT_CLOSE_GRACE_MS` and never used it,
// so a source scan asking "does this file share the constant" answered yes while the panel vanished in
// 35ms against the other two at ~172. A dead import references a constant perfectly.
//
// Measuring it needs two things the first attempt got wrong (recorded in the reject):
//   wait for the panel to be fully OPEN (opacity 1) — leaving during the enter animation gives a short
//   number whether or not there is a grace period;
//   move to the SAME neutral point from each panel, or the pointer's path is part of the measurement.
const NEUTRAL = { x: 6, y: 6 };

// A Radix tooltip renders its content twice: once to look at, and once inside a `<span role="tooltip">`
// clipped to rect(0,0,0,0) for screen readers. The clone is always present and always fully opaque, so
// "wait until nothing is visible" never finished and the Radix measurement came back null — the same
// clone that made #582 report a 219px overflow that did not exist.
// …and the panel is measured at its BOX. The content div inside a Radix tooltip keeps `opacity: 1` of its
// own however faded its parent is, so "every visible panel is transparent" was never true and the close
// never registered — measured: content 220px at opacity 1, inside a box already on its way out.
const VISIBLE = `[...new Set([...document.querySelectorAll("[data-role-panel], [data-slot=tooltip-content]")]
  .filter((e) => !e.closest('[role=tooltip][style*="clip"]'))
  .map((e) => e.closest("[data-slot=tooltip-content]") ?? e))]
  .filter((e) => e.getBoundingClientRect().width > 1)`;

/** Hover `trigger`, wait for a panel to be fully open, leave, and report how long it stayed. */
async function graceOf(page: Page, hover: () => Promise<void>): Promise<number | null> {
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y);
  await sleep(400);
  await hover();
  // fully open, not merely present: `opacity` reaching 1 is the end of the enter animation
  const opened = await page.waitForFunction(
    `(() => { const el = ${VISIBLE}[0]; return el ? Number(getComputedStyle(el).opacity) >= 1 : false })()`,
    undefined, { timeout: 6_000 }).catch(() => null);
  if (!opened) return null;

  const start = await page.evaluate(() => performance.now());
  // progressive, like the arrival: a teleporting pointer can leave a hover implementation believing it is
  // still inside — measured, the Radix panel never closed and the measurement came back null
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y, { steps: 6 });
  const gone = await page.waitForFunction(
    `(() => ${VISIBLE}.every((e) => Number(getComputedStyle(e).opacity) === 0))()`,
    undefined, { timeout: 6_000 }).catch(() => null);
  if (!gone) return null;
  const end = await page.evaluate(() => performance.now());
  return Math.round(end - start);
}

// #630 (review rejection): …and they must LEAVE the same way, not merely wait the same time.
//
// The grace and the exit are two different things and the previous round only unified the first: all
// three panels waited ~170ms, then the Radix one faded out over another 180ms while the hand-placed two
// blinked off the instant the timer fired. That is the same "two products" the ticket set out to remove,
// moved from the arrival to the departure.
//
// Sampled rather than measured at one instant, because an exit animation is a window: the panel is gone
// by the time a single late read happens, and a single early read catches the enter animation still
// named on the element. Poll from the moment the pointer leaves and keep every name seen.
async function namesWhileClosing(page: Page, hover: () => Promise<void>): Promise<string[] | null> {
  await page.mouse.move(NEUTRAL.x, NEUTRAL.y);
  await sleep(400);
  await hover();
  const opened = await page.waitForFunction(
    `(() => { const el = ${VISIBLE}[0]; return el ? Number(getComputedStyle(el).opacity) >= 1 : false })()`,
    undefined, { timeout: 6_000 }).catch(() => null);
  if (!opened) return null;

  await page.mouse.move(NEUTRAL.x, NEUTRAL.y, { steps: 6 });
  const seen = await page.evaluate(async (visibleExpr) => {
    const names = new Set<string>();
    const deadline = performance.now() + 4_000;
    // eslint-disable-next-line no-constant-condition
    while (performance.now() < deadline) {
      const els = eval(visibleExpr) as HTMLElement[];
      if (!els.length) break;
      for (const el of els) {
        // the animation runs on the panel's BOX, not on the content inside it — a child keeps its own
        // `opacity: 1` however faded its parent is, and its `animationName` is `none`. The first version
        // of this sampler read the inner `[data-role-panel]` div and saw nothing on either mechanism,
        // which is the same box-versus-content confusion recorded on the grace measurement.
        const box = (el.closest("[data-slot=tooltip-content]") ?? el.closest("[role=tooltip]") ?? el) as HTMLElement;
        const cs = getComputedStyle(box);
        if (Number(cs.opacity) < 1) names.add(cs.animationName);
      }
      await new Promise((r) => setTimeout(r, 8));
    }
    return [...names];
  }, VISIBLE);
  return seen;
}

test("#630: every floating explanation leaves the same way, not just after the same wait", async ({ page }) => {
  test.setTimeout(180_000);
  await openDemo(page);

  await page.goto("/admin/roles");
  await page.waitForSelector("[class*=cursor-help]", { timeout: 15_000 });
  await sleep(600);
  const radix = await namesWhileClosing(page, async () => {
    const t = page.locator("css=[class*=cursor-help]").first();
    const b = (await t.boundingBox())!;
    await page.mouse.move(b.x - 20, b.y + b.height / 2);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  });

  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15_000 });
  await sleep(600);
  const hand = await namesWhileClosing(page, async () => {
    const t = page.getByTestId("member-role-select").first();
    const b = (await t.boundingBox())!;
    await page.mouse.move(b.x - 20, b.y + b.height / 2);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  });

  // both mechanisms were reached — the premise every pin on this family has needed
  expect(radix, "the Radix panel opened and closed").not.toBeNull();
  expect(hand, "the hand-placed hint opened and closed").not.toBeNull();

  // What disqualifies a panel is fading with the ENTER animation still named on it, or with none at all:
  // both mean nothing was authored for the way out and the browser is simply removing the node.
  for (const [name, seen] of [["Radix", radix!], ["the hand-placed hint", hand!]] as const) {
    const exits = seen.filter((n) => n !== "enter" && n !== "none" && n !== "");
    expect(exits.length, `${name} animates on the way out — names seen while it faded: ${JSON.stringify(seen)}`)
      .toBeGreaterThan(0);
  }
  // …and it is the SAME exit, which is what "one behaviour" means
  expect(new Set([...radix!, ...hand!].filter((n) => n !== "enter" && n !== "none" && n !== "")).size,
    `the two mechanisms run different exits: Radix ${JSON.stringify(radix)} / hand-placed ${JSON.stringify(hand)}`)
    .toBe(1);
});

test("#630: every floating explanation waits the same beat before it closes", async ({ page }) => {
  test.setTimeout(180_000);
  await openDemo(page);

  // 1. the Radix-backed panel: a role name on the roles screen
  await page.goto("/admin/roles");
  await page.waitForSelector("[class*=cursor-help]", { timeout: 15_000 });
  await sleep(600);
  const radix = await graceOf(page, async () => {
    const t = page.locator("css=[class*=cursor-help]").first();
    const b = (await t.boundingBox())!;
    await page.mouse.move(b.x - 20, b.y + b.height / 2);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  });

  // 2. the hand-placed hint `Select` raises for its own current value
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15_000 });
  await sleep(600);
  const select = await graceOf(page, async () => {
    const t = page.getByTestId("member-role-select").first();
    const b = (await t.boundingBox())!;
    await page.mouse.move(b.x - 20, b.y + b.height / 2);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  });

  // both implementations were reached — without this the comparison is one panel against itself, which is
  // how three pins on this family passed while measuring nothing (#582, #630)
  expect(radix, "the Radix panel opened and closed").not.toBeNull();
  expect(select, "the hand-placed hint opened and closed").not.toBeNull();

  // A grace is present or it is not, and the two cases are far apart: measured on this screen, a panel
  // with the grace leaves after ~180-225ms and one without it after ~98 (the exit animation alone). The
  // floor sits between them rather than at the edge of either — a "the two agree within 80ms" comparison
  // passed with the grace removed on one run and failed on the next, because 183 against 98 is 85.
  for (const [name, ms] of [["Radix", radix!], ["Select", select!]] as const) {
    expect(ms, `${name} closed in ${ms}ms — that is the exit animation with no grace behind it`).toBeGreaterThan(140);
  }
  // …and they agree, which is what "one behaviour" means
  expect(Math.abs(radix! - select!),
    `the implementations disagree on the closing grace — Radix ${radix}ms, Select ${select}ms`)
    .toBeLessThanOrEqual(90);
});

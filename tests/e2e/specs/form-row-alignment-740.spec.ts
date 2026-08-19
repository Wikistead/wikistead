import { test, expect, type Page } from "@playwright/test";

// #740 (ruling): a field that wears a name still stands on the same line as the button beside it.
//
// The defect this exists to end is what #740 LEFT BEHIND. Giving nine fields a visible label made each
// of them one line taller than its neighbours, and the row they sat in centred its children — so on the
// API-key row, the webhook row and the invite row the box hung 11px below every plain control, the same
// figure on all three. The fix is one line in `FormRow`; this is the measurement that says it stayed
// fixed.
//
// WHY AN E2E. The whole claim is a computed distance. `items-center` and `items-end` are both perfectly
// reasonable-looking class names, so no grep can tell which one is right for a row whose children have
// different heights, and happy-dom has no layout engine — `getBoundingClientRect()` there returns zeroes
// for everything and would agree with any answer at all. #735 is the precedent and this uses its walk.
//
// ⚠️ THE WALK IS A DISCOVERY WALK, TWICE OVER. The screens come from the rail the app renders, and the
// rows come from the SHAPE OF THE DOM on those screens — a label laid out as a column that encloses a
// control, standing in a horizontal row beside a control that has no label. Neither list is written
// here. That matters because the defect was never about three screens: it was the row's rule meeting a
// child whose shape had changed, and the next screen to put a named field beside a button inherits both
// halves. It also reaches rows this ticket never touched: the second-factor removal confirm is a form
// cluster inside a LIST row, which is how it kept the old centring after the three named screens were
// fixed.

const RAIL_TABS = '[data-testid^="settings-tab-"]';

/** How far apart two controls on one line may sit before a reader sees one of them floating. */
const TOLERANCE = 1;

type Row = {
  where: string;
  /** The bottom edge of each control on the line, labelled by what it is. */
  controls: { what: string; bottom: number }[];
};

/**
 * Every row on this page that mixes a named field with a bare control, measured.
 *
 * A "named field" is the idiom this codebase writes: `<label class="flex flex-col">name<Input/></label>`
 * — the label is a column, so the words sit ABOVE the box and the whole child is a line taller than a
 * button. Found by computed style rather than by class name, because `flex-col` is one of several ways
 * to spell it and the layout is the thing that matters.
 */
async function rowsOn(page: Page, where: string): Promise<Row[]> {
  return page.evaluate((pageName) => {
    const CONTROL = "input, textarea, select, button, [role='combobox']";
    const seen = new Set<Element>();
    const out: { where: string; controls: { what: string; bottom: number }[] }[] = [];

    const name = (el: Element): string => {
      const id = el.getAttribute("data-testid") ?? el.closest("[data-testid]")?.getAttribute("data-testid");
      return id ?? `${el.tagName.toLowerCase()}${el.getAttribute("type") ? `[${el.getAttribute("type")}]` : ""}`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.width > 0;
    };

    for (const label of Array.from(document.querySelectorAll("label"))) {
      const control = label.querySelector(CONTROL);
      if (!control || !visible(control)) continue;
      const ls = getComputedStyle(label);
      // The words have to be ABOVE the control for this row to have the problem at all; a label that
      // lays its words out beside the box is already the same height as a button.
      if (!ls.display.includes("flex") || !ls.flexDirection.startsWith("column")) continue;

      const row = label.parentElement;
      if (!row || seen.has(row)) continue;
      const rs = getComputedStyle(row);
      if (!rs.display.includes("flex") || rs.flexDirection.startsWith("column")) continue;

      // The other children of this row, reduced to the control each one actually draws. A child that
      // draws no control (a helper sentence, an icon, a spacer) is not on trial: nothing about it says
      // where its bottom edge ought to be.
      const measured: { what: string; bottom: number }[] = [];
      let bare = 0;
      for (const child of Array.from(row.children)) {
        const control2 = child.matches(CONTROL) ? child : child.querySelector(CONTROL);
        if (!control2 || !visible(control2)) continue;
        const isNamed = control2.closest("label") !== null && row.contains(control2.closest("label"));
        if (!isNamed) bare += 1;
        measured.push({ what: `${name(control2)}${isNamed ? "" : " (no label)"}`, bottom: Math.round(control2.getBoundingClientRect().bottom) });
      }
      // Only rows that MIX the two shapes can be ragged. A row where every field wears a name lines up
      // whatever the rule is, and so does a row where none does.
      if (bare === 0 || measured.length < 2) continue;
      seen.add(row);
      out.push({ where: `${pageName} ${name(row)}`, controls: measured });
    }
    return out;
  }, where);
}

/** Walk whatever the rail is showing, and collect the mixed rows on each surface. */
async function walk(page: Page, root: string): Promise<Row[]> {
  await page.goto(root);
  await expect(page.locator(RAIL_TABS).first(), `the rail rendered at ${root}`).toBeVisible({ timeout: 30_000 });
  const hrefs = await page.locator(RAIL_TABS).evaluateAll((els) =>
    els.map((e) => ({ key: e.getAttribute("data-testid")!.replace("settings-tab-", ""), href: (e as HTMLAnchorElement).getAttribute("href")! })));
  expect(hrefs.length, `${root} has tabs to walk (a walk that finds nothing agrees with everything)`).toBeGreaterThan(3);

  const out: Row[] = [];
  for (const { key, href } of hrefs) {
    // A full navigation per tab, not a click — #735 measured the click version reporting one tab's DOM
    // N times, because the previous pane is still mounted while the next one arrives.
    await page.goto(href);
    await page.locator("section.overflow-y-auto [data-settings-pane]").first()
      .waitFor({ state: "attached", timeout: 20_000 })
      .catch(() => { /* a tab that draws no pane is #735's business, not this one */ });
    out.push(...await rowsOn(page, `${root} ${key}`));
  }
  return out;
}

test("#740: a named field and the button beside it stand on the same line", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1400, height: 900 });

  const rows = [...await walk(page, "/admin"), ...await walk(page, "/settings/account")];

  // 0. The walk found rows to judge. Every assertion below is vacuously true over an empty list, and
  //    this repository has shipped exactly that (#719, green over nothing for eleven days). Three is
  //    the floor because three separate screens were measured ragged in the ruling; finding fewer
  //    means a rail did not render or the row idiom moved, not that the product got simpler.
  expect(rows.length, `rows found: ${rows.map((r) => r.where).join(", ")}`).toBeGreaterThanOrEqual(3);

  // 1. Every such row is level. Measured on the CONTROLS, not on the children that hold them: the
  //    labelled child is taller by design and its top edge is supposed to be higher.
  const ragged = rows
    .map((r) => {
      const bottoms = r.controls.map((c) => c.bottom);
      const spread = Math.max(...bottoms) - Math.min(...bottoms);
      return { ...r, spread };
    })
    .filter((r) => r.spread > TOLERANCE)
    .map((r) => `${r.where}: ${r.spread}px apart — ${r.controls.map((c) => `${c.what}@${c.bottom}`).join(", ")}`);
  expect(ragged, `these rows put a named field and a bare control on different lines:\n${ragged.join("\n")}`).toEqual([]);
});

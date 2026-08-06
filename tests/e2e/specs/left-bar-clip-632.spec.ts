import { test, expect, type Page } from "@playwright/test";
import { openDemo, openScratch, enterEdit, sleep } from "../helpers";

// #632 (review rejection): every coloured left strip goes through the shared part, and none of them
// escapes the silhouette of the box it belongs to.
//
// Two things went wrong before, and both were about HOW the sweep was done rather than what it found:
//
//   the count came from grepping source. The seventh box spelled its border `border-[color-mix(…)]`
//   instead of `border-border`, so a pattern built around the other spelling never saw it — and the
//   confirming grep returned empty because of an unescaped `[`, which was read as absence;
//   straightening the bar removed the bend and introduced its opposite. `border-radius` clips a box's
//   background, not its absolutely-positioned children, so a square strip pokes OUT at the corners.
//   Invisible in light, plain in dark against the warning yellow.
//
// So this walks the real DOM, in the dark theme, and names no surface and no class.
const SCREENS = [
  { name: "auth", url: "/admin/auth" },
  { name: "members", url: "/admin/members" },
  { name: "roles", url: "/admin/roles" },
];

/** Every element wearing a coloured left strip, however it is drawn, with what it would take to be wrong. */
const STRIPS = `[...document.querySelectorAll('*')].map((el) => {
  const cs = getComputedStyle(el);
  const before = getComputedStyle(el, '::before');
  const w = (v) => parseFloat(v) || 0;
  // a strip is either a left border thicker than the other sides, or a ::before pinned to the left edge
  const borderStrip = w(cs.borderLeftWidth) >= 2 && w(cs.borderLeftWidth) > w(cs.borderRightWidth);
  const pseudoStrip = before.content !== 'none' && before.position === 'absolute'
    && w(before.left) === 0 && w(before.width) > 0 && w(before.width) <= 6
    && (w(before.top) === 0 || before.inset?.startsWith('0px'));
  if (!borderStrip && !pseudoStrip) return null;
  const radius = Math.max(w(cs.borderTopLeftRadius), w(cs.borderBottomLeftRadius));
  return {
    cls: (el.className?.toString?.() ?? '').slice(0, 60),
    testid: el.getAttribute('data-testid'),
    kind: borderStrip ? 'border' : 'pseudo',
    radius,
    // does the strip follow the box's corners? a pseudo strip must inherit them; a BORDER strip on a
    // rounded box is the original defect and cannot follow anything
    stripRadius: pseudoStrip ? Math.max(w(before.borderTopLeftRadius), w(before.borderBottomLeftRadius)) : 0,
    shared: el.classList.contains('wks-left-bar'),
  };
}).filter(Boolean)`;

async function stripsOn(page: Page): Promise<Record<string, unknown>[]> {
  return await page.evaluate(STRIPS) as Record<string, unknown>[];
}

test.beforeEach(async ({ page }) => {
  // dark, because that is where a strip escaping its corner is visible (the reject measured it there)
  await page.addInitScript(() => { try { localStorage.setItem("wks.theme", "dark"); } catch { /* private */ } });
});

test("#632: no coloured left strip is drawn as a border on a rounded box", async ({ page }) => {
  test.setTimeout(180_000);
  await openDemo(page);
  const found: Record<string, unknown>[] = [];
  for (const s of SCREENS) {
    await page.goto(s.url);
    await sleep(900);
    found.push(...(await stripsOn(page)).map((f) => ({ ...f, where: s.name })));
  }
  expect(found.length, "the walk found strips at all (else nothing below is measured)").toBeGreaterThan(0);

  // the original defect: a border strip cannot follow a corner, so on a rounded box it bends
  const bent = found.filter((f) => f.kind === "border" && (f.radius as number) > 0);
  expect(bent, `a coloured left border on a rounded box :: ${JSON.stringify(bent)}`).toEqual([]);
});

test("#632: every strip follows the corners of the box it is drawn in", async ({ page }) => {
  test.setTimeout(180_000);
  await openDemo(page);
  const escaping: Record<string, unknown>[] = [];
  for (const s of SCREENS) {
    await page.goto(s.url);
    await sleep(900);
    // a strip on a rounded box must be rounded to match; on a square box there is nothing to follow
    escaping.push(...(await stripsOn(page))
      .filter((f) => (f.radius as number) > 0 && (f.stripRadius as number) <= 0)
      .map((f) => ({ ...f, where: s.name })));
  }
  expect(escaping, `a square strip on a rounded box — it pokes out at the corners :: ${JSON.stringify(escaping)}`)
    .toEqual([]);
});

test("#632: the same holds for the strips the editor draws", async ({ page }) => {
  test.setTimeout(180_000);
  // The editing surface is where the seventh kind of strip lives (a callout is a run of lines, not a
  // box), and where the previous sweep could not reach — its walk never rendered a macro.
  await openScratch(page, `bar632-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no view");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: [
      ":::warning[Warning]", "warning body", ":::", "",
      ":::note[Note]", "note body", ":::", "",
      ":::todo", "- [ ] one", "- [ ] two", ":::", "",
    ].join("\n") } });
  });
  await sleep(1500);

  const strips = await stripsOn(page);
  expect(strips.length, "the editor really drew strips (else this measures an empty surface)").toBeGreaterThan(0);
  const bent = strips.filter((f) => f.kind === "border" && (f.radius as number) > 0);
  expect(bent, `a coloured left border on a rounded line :: ${JSON.stringify(bent)}`).toEqual([]);
  const escaping = strips.filter((f) => (f.radius as number) > 0 && (f.stripRadius as number) <= 0);
  expect(escaping, `a square strip on a rounded line :: ${JSON.stringify(escaping)}`).toEqual([]);
});

import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";
import { HAS_LEFT_BAR } from "../left-bar";

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
// #1042 / #979 (ADR-268 §3, ruling): this used to also walk /admin/auth, /admin/members and
// /admin/roles — but #979 replaced `wks-left-bar` there with NoticeBand, a tinted panel with no left
// strip at all, so that walk now finds nothing and the walk-found-something premise assertion is what
// went red (correctly — the pin was never wrong, the admin screens just stopped having a subject). The
// editor's callout panel is the only surface left that draws a bar, so this walks that surface alone.
//
// So this walks the real DOM, in the dark theme, and names no surface and no class.

/** Every element wearing a coloured left bar, however it is drawn, with what it would take to be wrong.
 *
 *  The predicate itself is shared (`../left-bar`) because the bar's MECHANISM has changed three times in
 *  this ticket and each change blinded the pins that hard-coded one — a pin that cannot see the bar
 *  reports an empty page and goes green on a defect. What is asked here is unchanged: whatever draws it,
 *  a bar must not be a border on a rounded box.
 */
const STRIPS = `[...document.querySelectorAll('*')].map((el) => {
  const cs = getComputedStyle(el);
  const before = getComputedStyle(el, '::before');
  const w = (v) => parseFloat(v) || 0;
  const kind = ${HAS_LEFT_BAR}(el);
  if (!kind) return null;
  const radius = Math.max(w(cs.borderTopLeftRadius), w(cs.borderBottomLeftRadius));
  return {
    cls: (el.className?.toString?.() ?? '').slice(0, 60),
    testid: el.getAttribute('data-testid'),
    kind,
    radius,
    // does the bar follow the box's corners? a pseudo strip has to inherit them; a BACKGROUND is clipped
    // by them whatever it says; a BORDER on a rounded box is the original defect and cannot follow
    // anything. A background reports the box's own radius because that is literally what clips it.
    stripRadius: kind === 'pseudo'
      ? Math.max(w(before.borderTopLeftRadius), w(before.borderBottomLeftRadius))
      : kind === 'background' ? radius : 0,
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

test("#632: no coloured left strip is drawn as a border on a rounded box, and every strip follows the corners of the box it is drawn in", async ({ page }) => {
  test.setTimeout(180_000);
  // The editing surface is where the strip lives now (a callout is a run of lines, not a box), and
  // where the earlier admin-screen sweep could never reach — its walk never rendered a macro.
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

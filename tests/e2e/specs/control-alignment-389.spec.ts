import { test, expect, type Page, type Locator } from "@playwright/test";
import { decodePng, inkCentroidMasked, closenessTo, differenceFrom, parseRgb, type Bitmap } from "../paint";

// #389 the DS selection controls must look centred at every zoom. Geometry pins cannot see the
// defect — measured the radio dot's rect as matching its ring to 0.008 CSS px while the paint
// sat up to 1.0 device px low, because the indicator and its frame were separate paint boxes rounding
// to device pixels independently. So every pin here weighs actual screenshot ink, at dsf 1, 1.25 and
// 1.5, and the fix is structural: each indicator is now painted BY the frame element itself (a
// radial-gradient background), so there is one box to round and the ink cannot drift out of it.

const DSFS = [1, 1.25, 1.5];
const TOL = 0.25; // device px — below the threshold where an edge reads as off-centre

async function box(el: Locator) {
  const b = await el.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

/** Screenshot one element with a margin, in DEVICE pixels (Playwright's default screenshot scale). */
async function shoot(page: Page, el: Locator, pad = 3): Promise<{ bm: Bitmap; scale: number; cx: number; cy: number }> {
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150); // let the scroll settle before the frame is captured
  const b = await box(el);
  const clip = { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
  const bm = decodePng(await page.screenshot({ clip }));
  const scale = bm.width / clip.width; // device px per CSS px, as actually rasterised
  // the element's centre inside the clip, in image pixels
  return { bm, scale, cx: (b.width / 2 + pad) * scale, cy: (b.height / 2 + pad) * scale };
}

/**
 * Only the pixels inside the element's own rounded shape. Both the knob and the check are near-white,
 * and so is the page behind them — and a control with rounded corners leaves page background inside
 * its bounding rect. Sweeping the rect would weigh that background and report its rounding instead of
 * the indicator's: a pin that measures nothing.
 */
function insideShape(pad: number, scale: number, w: number, h: number, radius: number) {
  const inset = 0.75; // device px, clear of the shape's own antialiased edge
  const x0 = pad * scale, y0 = pad * scale;
  const W = w * scale, H = h * scale, R = radius * scale;
  return (px: number, py: number) => {
    const x = px + 0.5 - x0, y = py + 0.5 - y0;
    if (x < inset || y < inset || x > W - inset || y > H - inset) return false;
    const cx = Math.min(Math.max(x, R), W - R);
    const cy = Math.min(Math.max(y, R), H - R);
    return Math.hypot(x - cx, y - cy) <= R - inset;
  };
}

async function cssVar(page: Page, name: string): Promise<string> {
  return page.evaluate((v) => {
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.backgroundColor = `var(${v})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  }, name);
}

/**
 * Paint a known colour directly behind one control. The knob and the check are white, and so is the
 * page under them, so without this the control's silhouette cannot be told from its background — and
 * the silhouette is what gives a sub-pixel centre. Only the backdrop changes; the control paints
 * exactly as it always does.
 */
const BACKDROP: [number, number, number] = [255, 0, 255];
async function backdrop(el: Locator) {
  await el.evaluate((node) => {
    const parent = (node as HTMLElement).parentElement;
    if (parent) parent.style.backgroundColor = "#ff00ff";
  });
}

async function openEditorSettings(page: Page) {
  await page.goto("/settings/account/editor");
  await page.locator("[data-slot=radio-group-choice]").first().waitFor({ timeout: 15000 });
}

// ── ① radio ────────────────────────────────────────────────────────────────────────────────────────
// The checked ring and its dot share one colour, so they are separated by radius: everything within
// 5 device px of the centre is dot, everything beyond 5.5 is ring. If the two ever paint apart, their
// centroids stop agreeing — which is exactly what the eye picks up.
for (const dsf of DSFS) {
  test(`#389 ①: the radio dot paints concentric with its ring (dsf ${dsf})`, async ({ browser }) => {
    const page = await (await browser.newContext({ deviceScaleFactor: dsf })).newPage();
    await openEditorSettings(page);
    const accent = parseRgb(await cssVar(page, "--accent"));
    const checked = page.locator('[data-slot=radio-group-choice][data-state="checked"]').first();
    await expect(checked).toBeVisible();
    const ring = checked.locator("span[class*=rounded-full]").first();

    const { bm, scale, cx, cy } = await shoot(page, ring);
    const near = closenessTo(accent);
    const dot = inkCentroidMasked(bm, (x, y) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < 5 * scale, near);
    const frame = inkCentroidMasked(bm, (x, y) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) >= 5.5 * scale, near);

    expect(dot.weight, "the dot is actually painted (never ship an invisible dot)").toBeGreaterThan(4 * scale);
    expect(frame.weight, "the ring is painted").toBeGreaterThan(4 * scale);
    expect(Math.abs(dot.x - frame.x), `dot vs ring, horizontal (device px, dsf ${dsf})`).toBeLessThan(TOL);
    expect(Math.abs(dot.y - frame.y), `dot vs ring, vertical (device px, dsf ${dsf})`).toBeLessThan(TOL);
  });
}

// ── ② switch ───────────────────────────────────────────────────────────────────────────────────────
// The knob must sit on the track's centre line with equal air above and below — and equal air at the
// end it is resting against, in both states. The old track was 1.15rem tall (18.4px, fractional) with
// a 16px knob, leaving 0.2px of margin: the knob looked jammed into the track at every zoom.
for (const dsf of DSFS) {
  test(`#389 ②: the switch knob is centred with symmetric air (dsf ${dsf})`, async ({ browser }) => {
    const page = await (await browser.newContext({ deviceScaleFactor: dsf })).newPage();
    await openEditorSettings(page);
    const sw = page.locator('[data-slot=switch]').first();
    await expect(sw).toBeVisible();
    if ((await sw.getAttribute("data-state")) !== "checked") await sw.click();
    await page.waitForTimeout(400); // the 120ms move, settled

    const pad = 2;
    await backdrop(sw);
    const b = await box(sw);

    // The knob is weighed against the pill AS PAINTED — never against the CSS rect, and never against
    // a bounding box, which quantises to whole pixels and so cannot resolve a fraction-of-a-pixel
    // drift. Everything that is not the backdrop is the pill: track plus knob, a symmetric shape
    // whose centroid is the true centre line at whatever subpixel offset the control happens to sit.
    const measure = async (trackVar: string) => {
      const track = parseRgb(await cssVar(page, trackVar));
      // half-way to the track colour, so a light grey track is never mistaken for the white knob
      const white = closenessTo([255, 255, 255], Math.hypot(255 - track[0], 255 - track[1], 255 - track[2]) / 2);
      const { bm, scale } = await shoot(page, sw, pad);
      return {
        scale,
        knob: inkCentroidMasked(bm, () => true, white),
        pill: inkCentroidMasked(bm, () => true, differenceFrom(BACKDROP, 60)),
        centre: (pad + b.width / 2) * scale,
      };
    };

    const on = await measure("--accent");
    expect(on.knob.weight, "the knob is painted").toBeGreaterThan(10 * on.scale);
    expect(on.pill.weight, "the track is painted").toBeGreaterThan(50 * on.scale);
    expect(Math.abs(on.knob.y - on.pill.y), `knob vs track centre line, on (device px, dsf ${dsf})`).toBeLessThan(TOL);

    await sw.click();
    await page.waitForTimeout(400);
    const off = await measure("--panel-3");
    expect(Math.abs(off.knob.y - off.pill.y), `knob vs track centre line, off (device px, dsf ${dsf})`).toBeLessThan(TOL);
    // the knob rests the same distance from whichever end it is against. Both states are measured
    // against the same reference, so a shared subpixel offset cancels and only asymmetry shows.
    expect(
      Math.abs((on.knob.x - on.centre) + (off.knob.x - off.centre)),
      `resting air at each end (device px, dsf ${dsf})`,
    ).toBeLessThan(1);
    expect(b.height, "the track has an integer height (no 1.15rem)").toBe(Math.round(b.height));
    expect(b.height - 16, "and real air around a 16px knob").toBeGreaterThanOrEqual(4);
  });
}

// ── ③ checkbox ─────────────────────────────────────────────────────────────────────────────────────
// A check mark's ink is not symmetric, so its centroid is not the box centre and never will be. What
// must hold is that the SAME glyph lands in the same place at every zoom: if the glyph and its box
// round independently, that offset moves with the device scale factor, which is the visible defect.
//
// It had it: as a 14px icon centred in a 16px bordered box, the glyph's rect sat at its own offset
// and rounded on its own, and the check moved up to 0.84 device px against its box between 1× and
// 1.5×. Pinning the glyph's rect to the box's own rect (an inset ring instead of a border, so the
// padding box and the border box coincide) brings that down to the antialiasing floor.
test("#389 ③: the checkbox glyph lands identically at every zoom", async ({ browser }) => {
  const offsets: { dsf: number; dx: number; dy: number }[] = [];
  for (const dsf of DSFS) {
    const page = await (await browser.newContext({ deviceScaleFactor: dsf })).newPage();
    await openEditorSettings(page);
    const cb = page.locator("[data-slot=checkbox]").first();
    await expect(cb).toBeVisible();
    if ((await cb.getAttribute("data-state")) !== "checked") await cb.click();
    await page.waitForTimeout(300);
    const glyph = parseRgb(await cssVar(page, "--accent-fg"));
    const pad = 2;
    await backdrop(cb);
    const b = await box(cb);
    const { bm, scale } = await shoot(page, cb, pad);
    const ink = inkCentroidMasked(bm, insideShape(pad, scale, b.width, b.height, 4), closenessTo(glyph, 70));
    // against the box as painted — its whole silhouette (fill plus glyph) is symmetric, so its
    // centroid is the painted centre, for the same reason as the switch above
    const boxInk = inkCentroidMasked(bm, () => true, differenceFrom(BACKDROP, 60));
    expect(ink.weight, `the check glyph is painted (dsf ${dsf})`).toBeGreaterThan(4 * scale);
    expect(boxInk.weight, `the box is filled (dsf ${dsf})`).toBeGreaterThan(20 * scale);
    // normalise to CSS px so the numbers are comparable across scale factors
    offsets.push({ dsf, dx: (ink.x - boxInk.x) / scale, dy: (ink.y - boxInk.y) / scale });
    await page.close();
  }
  // A stroked diagonal is not a box: where its antialiased mass falls genuinely depends on the raster
  // grid, so its centroid wobbles a couple of tenths of a pixel between scale factors wherever the
  // glyph is positioned. That floor is what this tolerance allows; layout drift, which is what this
  // ticket is about, is several times larger (the radio dot's was 0.58, the switch knob's 0.99).
  const GLYPH_TOL = 0.6;
  const base = offsets[0];
  for (const o of offsets.slice(1)) {
    expect(Math.abs(o.dx - base.dx) * o.dsf, `glyph x drift vs dsf 1 (device px, dsf ${o.dsf})`).toBeLessThan(GLYPH_TOL);
    expect(Math.abs(o.dy - base.dy) * o.dsf, `glyph y drift vs dsf 1 (device px, dsf ${o.dsf})`).toBeLessThan(GLYPH_TOL);
  }
});

// ── ④ the segmented selection frame ────────────────────────────────────────────────────────────────
// The selected segment is a filled block, so its own fill IS the cue. What must not happen is a
// half-painted edge — a fill that stops short of its box and leaves a lighter fringe along one side.
// Note what is NOT pinned: whether the fill's edges sit at the same subpixel phase top and bottom.
// A box that lands on a fractional device row antialiases its two edges differently no matter how it
// is styled; that is a property of where the row happens to fall, not of the control, and pinning it
// would only record which layout above it shifted last.
for (const dsf of [1, 1.25]) {
  test(`#389 ④: the segmented selection fills its whole segment (dsf ${dsf})`, async ({ browser }) => {
    const page = await (await browser.newContext({ deviceScaleFactor: dsf })).newPage();
    await openEditorSettings(page);
    const seg = page.locator('[data-testid^="account-tocdepth-"][data-state="checked"]').first();
    await expect(seg).toBeVisible();
    const accent = parseRgb(await cssVar(page, "--accent"));
    const pad = 2;
    const b = await box(seg);
    const { bm, scale } = await shoot(page, seg, pad);
    const fill = inkCentroidMasked(bm, () => true, closenessTo(accent, 60));
    expect(fill.weight, "the selected segment is filled with the brand accent").toBeGreaterThan(50 * scale);
    // coverage, not edge positions: a fill that stopped short of its box — the fringe this guards
    // against — loses whole percent of the area, whereas an edge reading is at the mercy of one
    // antialiased column
    const area = b.width * b.height * scale * scale;
    const glyphAndLabel = 0.2; // the Check and the label sit ON the fill and subtract from it
    expect(fill.weight / area, `the fill covers its segment (dsf ${dsf})`).toBeGreaterThan(1 - glyphAndLabel);
  });
}

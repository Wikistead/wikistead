// Where a floating panel goes. One rule, because the alternative is what #582 and #603 each measured
// separately: a panel parked off the screen edge, which is the same as no panel at all.
//
// It was already written once — inside `Select`, for the capability panel #582 settled on. #603 then grew
// two more panels (the group list, and that same capability panel raised from inside it) with their own
// `top`/`left` arithmetic and no viewport question at all, so they escaped: the second tier off the right
// at a 1000px window, the first tier off the bottom at a 420px one. Both rulings say the same thing —
// placement rides one shared rule (never build a second placement logic) — so the rule lives here and the panels
// call it.
//
// Two placements, because there are two relationships a panel can have to its anchor, not because there
// are two rules: BESIDE (a panel describing a row in a list, which must not cover the list) and BELOW (a
// panel hanging off a mark). Both flip to the opposite side when the preferred one has no room, and both
// clamp the other axis so nothing leaves the viewport in either direction.
//
// Sizes are MEASURED from the rendered panel by the caller and passed in. The old code guessed a height
// constant and was 61px adrift; a guess here would be the same defect with a new owner.

const GAP = 8;

/**
 * How much room a floating panel keeps between itself and the edge of the window.
 *
 * Exported because Radix positions its own tooltips and defaults that distance to ZERO, so the same
 * family of panels kept two answers: the ones placed here stopped 8px short, the Radix one sat flush
 * against the edge (measured at 1280x420: a box at y=375, 45 tall, in a 420 window — over by a fraction
 * of a pixel, and with nothing between the text and the edge). #582's ruling is one behaviour for the
 * family, so the number is shared rather than written twice.
 */
export const PANEL_EDGE = 8;
const EDGE = PANEL_EDGE;

export type Box = { width: number; height: number };
export type Viewport = { width: number; height: number };
export type At = { top: number; left: number };

const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });

/** Keep `start`..`start + size` inside `0..extent`, preferring `start`. */
function clamp(start: number, size: number, extent: number): number {
  return Math.max(EDGE, Math.min(start, extent - EDGE - size));
}

/**
 * Beside `beside`, level with `align`.
 *
 * `beside` is what the panel must not cover (an open list); `align` is what it describes (the row inside
 * it). For a panel hanging off a single element both are that element. It opens to the RIGHT and moves to
 * the left of `beside` when the right has no room — never on top of `beside`, which is the overlap #603
 * measured at 46px.
 */
export function placeBeside(beside: DOMRect, align: DOMRect, panel: Box, vp: Viewport = viewport()): At {
  const right = beside.right + GAP;
  const fitsRight = right + panel.width <= vp.width - EDGE;
  // The left side is only better if the panel actually fits there; when NEITHER side has room, staying on
  // the right and clamping keeps it on screen (over the anchor, but readable) rather than pinning it to
  // the left edge where it would cover more.
  const leftSide = beside.left - GAP - panel.width;
  const left = fitsRight ? right : leftSide >= EDGE ? leftSide : clamp(right, panel.width, vp.width);
  return { top: clamp(align.top, panel.height, vp.height), left };
}

/**
 * Below `anchor`, flipping above it when the space below cannot hold the panel.
 *
 * Left-aligned with the anchor and clamped horizontally, so a mark near the right edge still opens a
 * fully visible panel.
 */
export function placeBelow(anchor: DOMRect, panel: Box, vp: Viewport = viewport()): At {
  const below = anchor.bottom + 4;
  const above = anchor.top - 4 - panel.height;
  // Flip only when it does not fit below AND does fit above — flipping into a second overflow trades one
  // escaped edge for another.
  const top = below + panel.height <= vp.height - EDGE ? below : above >= EDGE ? above : clamp(below, panel.height, vp.height);
  return { top, left: clamp(anchor.left, panel.width, vp.width) };
}

import { TOOLTIP_DELAY_MS, TOOLTIP_CLOSE_GRACE_MS } from "../components/ui/tooltip";

// #582 (review rejection, ⑤): the box a floating explanation is drawn in — once.
//
// Measured on the device: the capability panel was `w-[220px]` with `px-2`, and its content reported
// `scrollWidth: 228` against `clientWidth: 220` on every row — 8px of text hanging outside the fill,
// because nothing told the words they were allowed to wrap. Three panels had grown their own box
// (`Select`'s hint, the group-roles list, and the tooltip content), so a fix in one of them would have
// been a fix in one of them; the ruling says to repair the vessel, the way #617 did for `ConfirmDialog`.
//
// Placement lives next door in `panel-placement`; this is only the look, so the two can be reasoned
// about apart: where it goes, and what it is.
//
// `break-words` is the whole point of the constant. A role name, a group name and a member's sub are all
// unbreakable runs to a browser, and the panel is deliberately narrow.
export const HINT_PANEL =
  "rounded-md border border-border bg-panel px-2 py-1.5 shadow-md [overflow-wrap:anywhere]";

/** The capability list's width. Content decides the OTHER panels' widths (③ withdrew the
 *  "make every panel the same width" ask), so this is not a shared constant — it belongs to the one
 *  panel that lists capabilities, and it is here so its box and its width stay together. */
export const HINT_PANEL_W = "w-[220px]";

// #630 (user ruling, 2026-08-05): " tooltip ".
//
// Placement was unified in #603 and the box in #582 ⑤; what was left drifting is the BEHAVIOUR.
// Measured before this: four implementations, three different open delays (180 / 180 / 0), two different
// close graces (0 / 160) and animation on exactly one of them (the Radix tooltip). A reader moving
// between the members table and a macro's chrome met two different products.
//
// This reverses #582 ①, which had settled the disagreement the other way — towards the majority,
// which was "no animation". The ruling picks the app's ordinary tooltip as the one everything matches.
//
// The close grace is NOT zero, and unifying does not mean making it zero. #603's nested hover (mark →
// list → role name → capability panel) only works because the panel survives the few pixels of gap the
// pointer crosses; a shared behaviour that dropped it would take that walk away. So the grace is handed
// to every implementation rather than removed from the one that had it.
export const HINT_OPEN_DELAY_MS = TOOLTIP_DELAY_MS;
export const HINT_CLOSE_GRACE_MS = TOOLTIP_CLOSE_GRACE_MS;

// The entrance: a pop, at the motion tokens' values.
//
// #630 first replaced the pop with a bare fade at `--dur-fast`, and the result was invisible — a 120ms
// cross-fade on a panel the eye is already resting on reads as nothing happening ("
// "). `--dur-fast` is the token for "hover / press / small state
// changes"; a floating panel arriving is what `--dur-base` is for, which is what `.wks-pop` in tokens.css
// already used.
//
// So why not `.wks-pop` itself, which the review pointed at? Measured: it sets `animation` as a
// SHORTHAND, and that overrides the `animate-out` Radix drives through `data-[state=closed]` — the
// tooltip lost its exit entirely (102ms against the 180 its siblings take). These hand-placed panels
// unmount rather than animating out, so the shorthand would cost THEM nothing, but then the two
// mechanisms would run different keyframes and #582's parity pin would be right to fail. Same
// utilities on both sides, same tokens, one animation name.
//
// The scale was once dropped on the theory that a panel cannot both scale and measure itself. Wrong, and
// the counter-example was already in the tree: `GroupRolesMark` measures with `offsetWidth`/
// `offsetHeight` — the LAYOUT box, which a transform does not touch — exactly so a scaling entrance
// cannot lie to it. `getBoundingClientRect` is the one that reads the box after transform.
//
// The exit is written the same way, keyed off `data-state` exactly as Radix's is, so both mechanisms run
// the one pair of keyframes. Without it a hand-placed panel simply stopped existing when its grace timer
// fired: measured, a role name's panel faded over 180ms while the Select hint blinked off. The
// grace and the exit are separate — the first is for the pointer crossing a gap, the second is how the
// panel leaves once it has decided to.
export const HINT_PANEL_ANIM =
  "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 " +
  "data-[state=closed]:zoom-out-95 duration-[var(--dur-base)] ease-[var(--ease-out)]";

/** How long a hand-placed panel stays mounted after it closes, so its exit can run.
 *
 *  Radix reads the animation off the node; these panels are unmounted by their own React state, so the
 *  duration has to be known here too. It is `--dur-base` — the same 180ms the class above animates for —
 *  and the pin measures the two mechanisms against each other rather than against this number, so a
 *  drift between them fails rather than being enshrined. */
export const HINT_EXIT_MS = 180;

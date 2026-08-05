import { TOOLTIP_DELAY_MS } from "../components/ui/tooltip";

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
export const HINT_CLOSE_GRACE_MS = 160;

// The entrance, as classes for React panels. Duration and easing come from the tokens (`--dur-fast`,
// `--ease-out`) rather than tw-animate's defaults, so a change to the motion scale reaches these too.
// `.wks-tip` — the delegated host's single reused node, which is plain DOM and gets no Tailwind — is
// given the same animation in `tokens.css`, keyed off the same variables.
//
// FADE ONLY, deliberately: the app tooltip's entrance was `fade-in-0 zoom-in-95`, and the scale half of
// it broke placement. These panels measure themselves to decide which side to open on (#603), and
// `getBoundingClientRect` returns the box AFTER transform — so a panel measured mid-entrance reports 95%
// of the height it is about to have, the clamp is computed against the smaller number, and the second
// tier ended up 17px below a 420px-tall viewport. The #603 pin caught it. Measuring the layout box
// instead is not enough on its own, because the panel has to exist before it can be measured and the
// first pass necessarily runs without it.
//
// So the shared entrance is opacity only. It is the same motion on every surface, which is what the
// ruling asked for, and it cannot lie to a measurement.
export const HINT_PANEL_ANIM =
  "animate-in fade-in-0 duration-[var(--dur-fast)] ease-[var(--ease-out)]";

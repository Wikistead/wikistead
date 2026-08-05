// #582 (review rejection,⑤): the box a floating explanation is drawn in — once.
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

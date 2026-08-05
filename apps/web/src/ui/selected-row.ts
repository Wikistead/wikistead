// #632 (user ruling, 2026-08-05): how a list says which row you are on.
//
// The settings nav marked its selection with `inset 2px 0 0 accent` on a `rounded-md` box, so the bar
// curved inward at both ends — the shape the ruling names. The page tree had already answered the same
// question differently, with a wash of accent and no bar at all, and the ruling picks that one.
//
// It is a constant because there are two lists today and the third would otherwise invent a third
// answer (the `HINT_PANEL` lesson from #582: a look that lives in two places drifts into two looks).
export const SELECTED_ROW =
  "bg-[color-mix(in_srgb,var(--accent)_12%,var(--panel-3))] font-medium";

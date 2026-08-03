import { RoleCaps } from "../ui/RoleTip";
import type { SelectOption } from "../ui/Select";

// #586 (review rejection, 2026-08-03): — every surface that
// shows a role name shows the NAME, and says what it confers when asked.
//
// One place, because the alternative is what the last two rounds produced: each screen deciding for
// itself whether a picker explains its choices, and a reviewer discovering the ninth one that does not.
// A caller builds its options as it always did and hands them here.

/** An option that knows what its role confers, before it is turned into something a Select renders. */
export interface RoleChoice extends SelectOption {
  /** a custom role's own capabilities; absent for a built-in tier (see below) */
  roleCapabilities?: readonly string[];
}

/**
 * Wraps each option's label so hovering, focusing or arrowing onto it reveals the capability list.
 *
 * TENANT TIERS (`member` / `admin`) are deliberately left bare. What a tier confers is not in either
 * measured table — those cover space and page scope — and ADR-203 §4's whole point is that a static
 * bundle written by hand is how a screen ends up stating a confident falsehood. The ruling on this
 * bounce allowed exactly this choice (" tier tooltip "), so a tier shows its
 * name and nothing else until the truth test grows a tenant-scope measurement. It is the absence of a
 * capability source that makes a tooltip absent — not a list of exceptions kept somewhere.
 */
export function withRoleTips(options: readonly RoleChoice[], scope: "space" | "page" | "tenant"): SelectOption[] {
  return options.map((o) => {
    const caps = o.roleCapabilities;
    if (!caps) return { value: o.value, label: o.label };
    // #582 (review rejection): a floating panel beside the list, not a reveal inside the row. Same component
    // the row badges raise, so there is one design rather than two that drift.
    return { value: o.value, label: o.label, hint: <RoleCaps origin="role" scope={scope} roleCapabilities={caps} /> };
  });
}

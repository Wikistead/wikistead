import { RoleCaps } from "../ui/RoleTip";
import type { SelectOption } from "../ui/Select";

// #586 (review rejection, 2026-08-03): show only the role name, reveal capabilities on hover — every
// surface that shows a role name shows the NAME, and says what it confers when asked.
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
 * TENANT TIERS now explain themselves too (#582 ①), but only where the answer is honest. `admin` is
 * structural and measured; `member` rides a per-tenant switch, so its list is passed in from the live
 * defaults by the caller (see `tenantTierCaps`) and is simply ABSENT where those are unknown. The rule
 * here is unchanged and is the reason this works: a panel appears when the option carries a capability
 * source, and never because a screen wrote one by hand. ADR-203 §4's confident falsehood is avoided by
 * having no source rather than by keeping a list of exceptions.
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

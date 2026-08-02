import type { LoginMethodState } from "../data/queries";

// #537 / ADR-195 §1: how a method's state reads when it is NOT effective. A method the ceiling
// excludes is unavailable BY POLICY, never silently off — the tenant's stored selection is untouched
// and returns with the ceiling. Same for the plan (ADR-072: an entitlement loss on an admin surface is
// named to admins, and the data is preserved).
//
// #589 moved this out of the status card it was born in: the card is gone (each row of the sign-in
// methods list carries its own state), but the classification is still the thing that decides whether
// a row shows "blocked by policy" beside its own switch.
export type MethodBadge = "effective" | "byPolicy" | "unentitled" | "off";

export function methodBadge(m: LoginMethodState & { entitled?: boolean }): MethodBadge {
  if (m.effective) return "effective";
  if (!m.inCeiling && m.selected) return "byPolicy";
  if (m.entitled === false && m.selected) return "unentitled";
  return "off";
}

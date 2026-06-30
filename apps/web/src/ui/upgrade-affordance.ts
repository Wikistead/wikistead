// #109 / ADR-072 frontend disclosure rule (PURE — no DOM). The keystone that prevents an
// access-loss from leaking the wrong way:
//   - AUTHZ loss → NEVER show an upgrade affordance (the resource is existence-hidden; a "you lost
//     access / upgrade" hint would leak that it exists). authz-deny must not fall through to the
//     entitlement branch — this returns false unconditionally for authz.
//   - ENTITLEMENT loss → show the upgrade affordance ONLY to owner/admin (a general member or guest
//     sees the non-destructive stripped state, never an upgrade hint).
// The server already returns the two shapes (entitlement-ux.ts: notFound vs entitlementDenied);
// this is the matching client gate so the UI can't surface a hint the disclosure rules forbid.
export type DisclosureKind = "authz" | "entitlement";
export type ViewerRole = "owner" | "admin" | "member" | "guest";

export function shouldShowUpgradeAffordance(kind: DisclosureKind, role: ViewerRole): boolean {
  if (kind === "authz") return false; // existence hidden — no affordance, ever (not even for admins)
  return role === "owner" || role === "admin"; // entitlement loss: privileged roles only
}

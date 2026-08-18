// #723 / ADR-232 §2: the CE side of "is SCIM part of this build?" — a registration marker, nothing
// else. It answers the same question audit/sink.ts and analytics/sink.ts answer, in the same way,
// for the same reason.
//
// ⚠️ NOT in src/scim/ although that is its natural home: that directory held the EE implementation
// before #178 moved it out, so the publication filter erases the path FOREVER (moved-away paths stay
// listed, or history resurrects them). A CE seam filed there ships in no mirror — measured on the
// first --run after #723 landed: the published build failed on this very import.
//
// Why a marker and not an entitlement read: the admin console asks the server which surfaces it may
// enter (ADR-208), and a CE build has no `/scim/v2` routes at all — a tab there would open onto
// nothing. That is a question about the BUILD, so a registration answers it. Whether a Cloud tenant
// on a lower plan may use SCIM is a different question, answered per request by the route's
// entitlement gate, with the upgrade affordance ADR-072 requires. Reading the `scim` lever here
// instead would be an EE lever's enforcement in CE bytes, which #693's lint refuses outright.
//
// The EE composition root registers this next to registerEeAudit(); a CE build never loads that
// file, so the answer stays false and the tab never appears.

let registered = false

/** Called by the EE composition root (packages/ee-server) at boot. */
export function registerScim(): void {
  registered = true
}

/** Test escape: back to the CE default. Module state is per-vitest-file. */
export function resetScimRegistration(): void {
  registered = false
}

/** Does this build serve SCIM at all? */
export function scimRegistered(): boolean {
  return registered
}

// #1107 / ADR-280 §2: the CE side of "does this build serve admin visibility of member identity links
// at all?" — a registration marker, mirroring scim-sink.ts's registerScim()/scimRegistered() shape
// (ADR-232 §2) exactly. The route this gates (`GET /admin/members/:sub/identities`) is EE-only, and a
// CE build has no such route — the member-row expand section must know that BEFORE rendering its
// toggle, or a CE admin gets a control that always 404s.
//
// Why a marker and not an entitlement read: this is a question about the BUILD (does the route exist
// at all), not about a plan. Reading an EE lever here instead would be an EE lever's enforcement in CE
// bytes, which #693's lint refuses outright.

let registered = false

/** Called by the EE composition root (packages/ee-server) at boot. */
export function registerMemberIdentities(): void {
  registered = true
}

/** Test escape: back to the CE default. Module state is per-vitest-file. */
export function resetMemberIdentitiesRegistration(): void {
  registered = false
}

/** Does this build serve admin visibility of member identity links at all? */
export function memberIdentitiesRegistered(): boolean {
  return registered
}

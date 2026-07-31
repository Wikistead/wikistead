// #554 / ADR-197 §5 (S0): the reserved internal sub space, enforced at EVERY seam where an
// EXTERNALLY-asserted subject becomes a principal. Future connections mint member subs as
// `wc<conn8>_<externalSub>` and local members as `wlocal_<uuid>`; the `(tenant_id, sub)` upsert
// MERGES equal subs, so an IdP-side actor who controls their own sub/NameID could otherwise mint a
// colliding value and BECOME another connection's member (SCIM — where the client chooses the sub —
// and the OIDC bearer path make this a live hole TODAY, before any second connection exists).
//
// The refusal applies to EXTERNAL assertions only. Sub values read back from OUR OWN storage
// (API-key owner ids, session rows, member rows) are internal and must pass — otherwise every future
// local member's API key would die at the gate that exists to protect them.
//
// The length cap: FGA's measured user-id grammar is `^[^\s]{2,512}$`; the longest reserved prefix
// (`wc<8>_` = 11 bytes) must still fit, so external subjects cap at 501.
export const RESERVED_SUB_RE = /^(wc[0-9a-f]{8}_|wlocal_)/
export const MAX_EXTERNAL_SUB_LENGTH = 501

export function externalSubViolation(sub: string): 'reserved' | 'too-long' | null {
  if (RESERVED_SUB_RE.test(sub)) return 'reserved'
  if (sub.length > MAX_EXTERNAL_SUB_LENGTH) return 'too-long'
  return null
}

// Throws the CALLER's uniform failure so each seam keeps its own error surface (a login seam answers
// like a failed login, SCIM like an invalid SCIM payload, the bearer path like a bad token — never a
// distinguishable oracle for probing the reserved space).
export function assertExternalSub(sub: string, fail: (reason: 'reserved' | 'too-long') => Error): void {
  const v = externalSubViolation(sub)
  if (v) throw fail(v)
}

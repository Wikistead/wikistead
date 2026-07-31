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
// The length cap: FGA's measured user-id grammar is `^[^\s]{2,512}$` (counted in characters); the
// longest reserved prefix (`wc<8>_` = 11 characters) must still fit, so external subjects cap at
// 501. The comparison uses `.length` (UTF-16 code units), which over-counts astral characters
// against FGA's character count — strictly TIGHTER than the grammar, i.e. fail-closed.
export const RESERVED_SUB_RE = /^(wc[0-9a-f]{8}_|wlocal_)/
export const MAX_EXTERNAL_SUB_LENGTH = 501

export type ExternalSubViolation = 'reserved' | 'too-long' | 'malformed'

export function externalSubViolation(sub: string): ExternalSubViolation | null {
  if (RESERVED_SUB_RE.test(sub)) return 'reserved'
  if (sub.length > MAX_EXTERNAL_SUB_LENGTH) return 'too-long'
  // the REST of the FGA grammar: whitespace anywhere or length < 2 never reaches FGA as a valid
  // user id — refusing HERE keeps the failure at the seam's own shape instead of a downstream
  // FGA write/check error (S0 review, concern 4)
  if (sub.length < 2 || /\s/.test(sub)) return 'malformed'
  return null
}

// Throws the CALLER's uniform failure so each seam keeps its own error surface (a login seam answers
// like a failed login, SCIM like an invalid SCIM payload, the bearer path like a bad token — never a
// distinguishable oracle for probing the reserved space).
export function assertExternalSub(sub: string, fail: (reason: ExternalSubViolation) => Error): void {
  const v = externalSubViolation(sub)
  if (v) throw fail(v)
}

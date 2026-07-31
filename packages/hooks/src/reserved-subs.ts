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
// The length cap, MEASURED against OpenFGA (v1.18, S0 re-verification): the constraint is BYTES on
// the whole `user:<id>` value — 512 bytes total (an ASCII id of 507 passes, 508 fails; the id
// itself may be 1 character, so the documented `{2,512}` grammar binds the whole string, not the
// id). Budget: 512 − 5 (`user:`) = 507 bytes for the id, minus the longest reserved prefix
// (`wc<8>_` = 11 bytes) = 496 bytes for an external subject. Compared as UTF-8 bytes
// (UTF-8 byte count) — a `.length` code-unit comparison UNDER-counts multi-byte characters and
// was measured fail-open (a 200-char / 600-byte kana sub sailed past the gate and 500'd inside
// FGA instead).
export const RESERVED_SUB_RE = /^(wc[0-9a-f]{8}_|wlocal_)/
export const MAX_EXTERNAL_SUB_LENGTH = 496

export type ExternalSubViolation = 'reserved' | 'too-long' | 'malformed'

// UTF-8 byte count without Buffer/TextEncoder — this package carries no node types and is
// environment-neutral. Unpaired surrogates never occur here (subs arrive as validated JWT/SCIM
// strings); for-of iterates code points, so each is counted at its real encoded width.
const utf8ByteLength = (s: string): number => {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

export function externalSubViolation(sub: string): ExternalSubViolation | null {
  if (RESERVED_SUB_RE.test(sub)) return 'reserved'
  if (utf8ByteLength(sub) > MAX_EXTERNAL_SUB_LENGTH) return 'too-long'
  // Whitespace is measured-REJECTED by FGA; refusing it HERE keeps the failure at the seam's own
  // shape instead of a downstream FGA write/check 500. An empty subject is refused as our own
  // restriction (no external identity is the empty string) — NOT an FGA rule (measured: FGA
  // accepts a 1-character id, so no minimum-length claim is made beyond non-empty).
  if (sub.length === 0 || /\s/.test(sub)) return 'malformed'
  return null
}

// Throws the CALLER's uniform failure so each seam keeps its own error surface (a login seam answers
// like a failed login, SCIM like an invalid SCIM payload, the bearer path like a bad token — never a
// distinguishable oracle for probing the reserved space).
export function assertExternalSub(sub: string, fail: (reason: ExternalSubViolation) => Error): void {
  const v = externalSubViolation(sub)
  if (v) throw fail(v)
}

import { createHash } from 'node:crypto'

// Audit-log hash chain (#134 / ADR-070, EE) — the append-only INTEGRITY primitive. Each entry
// carries the previous entry's hash; an entry's own hash covers (prev_hash || its canonical
// fields). Tampering with a field, deleting an entry, or reordering entries breaks the chain and
// is detected by verifyAuditChain. The chain is per tenant (within the RLS boundary); an export
// can include the verification result.
//
// This is PURE (no DB/IO) so it is exhaustively unit-testable. It records ONLY actor/action/
// target/time + seq (ADR-070: never content/secrets/tokens — recording them would itself be a
// disclosure surface). The durable in-tx outbox WRITE path (operation ⇒ audit row, never
// best-effort) is a separate concern built on this primitive.

export interface AuditEntryCore {
  seq: number // monotonic per tenant (ordering + dedup)
  tenantId: string
  actor: string // 'user:<sub>' | 'operator:<id>' | 'system'
  action: string // e.g. 'member.removed'
  target: string // resource ref, e.g. 'page:<id>' ('' when not applicable)
  at: string // ISO 8601 timestamp
  /**
   * #684 / ADR-223: what the action changed, as `{field: {from, to}}` — absent for most actions.
   *
   * ⚠️ Absent must stay absent. It is not `{}`: the canonical form below gains an ELEMENT when this is
   * present, so an entry without it hashes the six elements it always hashed. That is the whole of the
   * compatibility story, and `audit_log` is append-only for the app role, so getting it wrong makes
   * every existing row read as tampered with and offers no way back.
   */
  changes?: Record<string, { from: unknown; to: unknown }>
}

export interface AuditEntry extends AuditEntryCore {
  prevHash: string // hash of the previous entry ('' for the genesis entry)
  hash: string // hash of THIS entry
}

export const GENESIS_PREV = '' // prevHash of the first entry in a tenant's chain

// Canonical serialization: a fixed field order, only the integrity-relevant fields. No object
// key-order ambiguity (array form), so the hash is stable across producers.
//
// #684 / ADR-223: `changes` extends the ARITY rather than adding a field. A seventh element appears
// only when there is a payload, so every entry written before this — and every entry written after it
// that carries nothing — hashes exactly the six elements it did before. A version field would not have
// worked: adding one changes the input for the old rows too, and they cannot be re-hashed (`audit_log`
// grants the app role SELECT and INSERT only). The arity IS the version.
//
// The payload is canonicalised by SORTED KEYS, because `JSON.stringify` preserves insertion order and
// two producers building the same object differently would otherwise disagree about a chain they both
// verify.
function canonicalChanges(c: Record<string, { from: unknown; to: unknown }>): unknown {
  return Object.keys(c).sort().map((k) => [k, c[k]!.from ?? null, c[k]!.to ?? null])
}

function canonical(e: AuditEntryCore): string {
  const head = [e.seq, e.tenantId, e.actor, e.action, e.target, e.at]
  return JSON.stringify(e.changes ? [...head, canonicalChanges(e.changes)] : head)
}

export function computeEntryHash(prevHash: string, core: AuditEntryCore): string {
  return createHash('sha256').update(prevHash).update('\n').update(canonical(core)).digest('hex')
}

// Link a new entry onto the chain (prev = null for the genesis entry).
export function linkEntry(prev: AuditEntry | null, core: AuditEntryCore): AuditEntry {
  const prevHash = prev ? prev.hash : GENESIS_PREV
  return { ...core, prevHash, hash: computeEntryHash(prevHash, core) }
}

export interface ChainVerdict {
  valid: boolean
  brokenAt?: number // index of the first broken entry
  reason?: string
}

// Verify an ordered chain. Detects:
//   - tamper:  a recomputed hash no longer matches the stored hash;
//   - deletion: an entry's prevHash no longer continues the running hash;
//   - reorder: same continuity break (a moved entry's prevHash won't match).
// A full-suffix re-forge requires recomputing every later hash; a trusted anchor (the latest
// hash, persisted/exported separately) closes that — out of scope for this pure primitive.
export function verifyAuditChain(entries: AuditEntry[]): ChainVerdict {
  let prevHash = GENESIS_PREV
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.prevHash !== prevHash) return { valid: false, brokenAt: i, reason: 'prev_hash discontinuity (deletion/reorder)' }
    if (computeEntryHash(prevHash, e) !== e.hash) return { valid: false, brokenAt: i, reason: 'hash mismatch (tamper)' }
    prevHash = e.hash
  }
  return { valid: true }
}

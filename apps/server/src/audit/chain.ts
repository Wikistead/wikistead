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
}

export interface AuditEntry extends AuditEntryCore {
  prevHash: string // hash of the previous entry ('' for the genesis entry)
  hash: string // hash of THIS entry
}

export const GENESIS_PREV = '' // prevHash of the first entry in a tenant's chain

// Canonical serialization: a fixed field order, only the integrity-relevant fields. No object
// key-order ambiguity (array form), so the hash is stable across producers.
function canonical(e: AuditEntryCore): string {
  return JSON.stringify([e.seq, e.tenantId, e.actor, e.action, e.target, e.at])
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

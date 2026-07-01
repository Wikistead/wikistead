import type postgres from 'postgres'
import { linkEntry, verifyAuditChain, type AuditEntry, type AuditEntryCore } from './chain.js'

// Operator audit ledger (#179 / ADR-089) — the durable, append-only, hash-chained record of operator
// out-of-band privileged actions (break-glass), SEPARATE from the tenant audit_log (#177). One GLOBAL
// chain: the chain primitive's tenant slot is a fixed scope tag ('@operator') so `chain.ts` is reused
// unchanged. Records integrity fields ONLY (actor/action/target/time/seq) — never secrets/config
// (ADR-070). Writes go through the operator/admin connection (BYPASSRLS); the tenant `app` role has no
// access (migration 047). See docs/adr/089-operator-audit-ledger.md.

export const OPERATOR_SCOPE = '@operator'
// A fixed advisory-lock key for the operator chain: SERIALIZE appends within their transaction so two
// concurrent operator actions can't read the same tail and fork the chain (break-glass is rare, but
// the chain integrity contract must hold regardless).
const OPERATOR_CHAIN_LOCK = 179179

export interface OperatorAction {
  actor: string  // 'operator:<id>'
  action: string // e.g. 'tenant.oidc_recovered'
  target: string // e.g. 'tenant:<id>' ('' when not applicable)
  at: string     // ISO 8601 timestamp
}

// Append one entry to the operator chain, IN THE CALLER'S TRANSACTION (`tx`), so the privileged action
// and its ledger row commit together — if the insert fails, the whole break-glass rolls back (no
// unrecorded privilege use). Takes an advisory xact lock first (no fork), reads the current tail for
// prev_hash + seq, links, and inserts. Returns the linked entry. MUST run on an admin/operator
// connection (the tenant `app` role has no privileges on the table).
export async function appendOperatorEntry(tx: postgres.TransactionSql, action: OperatorAction): Promise<AuditEntry> {
  await tx`SELECT pg_advisory_xact_lock(${OPERATOR_CHAIN_LOCK})`
  const [last] = await tx<{ seq: string | number; hash: string }[]>`
    SELECT seq, hash FROM operator_audit_log ORDER BY seq DESC LIMIT 1
  `
  const prevSeq = last ? Number(last.seq) : 0
  const prev = last ? ({ hash: last.hash } as AuditEntry) : null // linkEntry only reads prev.hash
  const core: AuditEntryCore = {
    seq: prevSeq + 1,
    tenantId: OPERATOR_SCOPE,
    actor: action.actor,
    action: action.action,
    target: action.target,
    at: action.at,
  }
  const linked = linkEntry(prev, core)
  await tx`
    INSERT INTO operator_audit_log (seq, actor, action, target, at, prev_hash, hash)
    VALUES (${core.seq}, ${core.actor}, ${core.action}, ${core.target}, ${core.at}, ${linked.prevHash}, ${linked.hash})
  `
  return linked
}

// Read the full operator chain (seq order) and verify its integrity — operator-side audit/export.
// Runs on an admin/operator connection. Returns the entries + the chain verdict.
export async function readOperatorChain(sql: postgres.Sql): Promise<{ entries: AuditEntry[]; verdict: ReturnType<typeof verifyAuditChain> }> {
  const rows = await sql<{ seq: string | number; actor: string; action: string; target: string; at: string; prev_hash: string; hash: string }[]>`
    SELECT seq, actor, action, target, at, prev_hash, hash FROM operator_audit_log ORDER BY seq ASC
  `
  const entries: AuditEntry[] = rows.map((r) => ({
    seq: Number(r.seq),
    tenantId: OPERATOR_SCOPE,
    actor: r.actor,
    action: r.action,
    target: r.target,
    at: r.at, // stored byte-exact (TEXT) — the same string the hash was computed from
    prevHash: r.prev_hash,
    hash: r.hash,
  }))
  return { entries, verdict: verifyAuditChain(entries) }
}

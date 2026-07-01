// Operator audit ledger (#179 / ADR-089) — integration (real Postgres). The durable, hash-chained
// record of operator break-glass actions, SEPARATE from the tenant audit_log and OPERATOR-ONLY.
// Verifies: appends chain correctly and read back VALID; the tenant `app` role CANNOT read it
// (operator-only isolation — the security core); a tampered entry is detected. The admin connection
// (BYPASSRLS) is what writes/reads it, exactly as the CLI runs.
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { appendOperatorEntry, readOperatorChain, OPERATOR_SCOPE } from '../audit/operator-ledger.js'
import { verifyAuditChain } from '../audit/chain.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)       // superuser / BYPASSRLS (operator role)
const appRole = postgres(process.env.DATABASE_URL!)           // restricted runtime role (NOBYPASSRLS)

afterAll(async () => { await admin.end(); await appRole.end() })

describe('operator audit ledger (#179 / ADR-089)', () => {
  it('appends a hash-chained entry in the caller tx; the whole chain reads back VALID', async () => {
    const before = (await readOperatorChain(admin)).entries.length
    const e1 = await admin.begin((tx) => appendOperatorEntry(tx, { actor: 'operator:led-a', action: 'tenant.oidc_recovered', target: 'tenant:led-a', at: '2026-07-02T00:00:00.000Z' }))
    const e2 = await admin.begin((tx) => appendOperatorEntry(tx, { actor: 'operator:led-b', action: 'tenant.oidc_recovered', target: 'tenant:led-b', at: '2026-07-02T00:00:01.000Z' }))
    expect(e2.seq).toBe(e1.seq + 1)     // monotonic seq
    expect(e2.prevHash).toBe(e1.hash)   // chained to the previous entry
    expect(e1.tenantId).toBe(OPERATOR_SCOPE)

    const { entries, verdict } = await readOperatorChain(admin)
    expect(verdict.valid).toBe(true)                 // the whole accumulated chain verifies
    expect(entries.length).toBe(before + 2)
    const a = entries.find((e) => e.actor === 'operator:led-a')!
    expect(a).toMatchObject({ action: 'tenant.oidc_recovered', target: 'tenant:led-a', tenantId: OPERATOR_SCOPE })
    // Integrity fields only — no secret/config columns exist to leak (ADR-070): the row is exactly
    // {seq, actor, action, target, at, prevHash, hash}.
    expect(Object.keys(a).sort()).toEqual(['action', 'actor', 'at', 'hash', 'prevHash', 'seq', 'target', 'tenantId'])
  })

  it('the tenant (app) role CANNOT read the operator ledger (operator-only isolation)', async () => {
    // No grant to `app` + RLS forced with no policy ⇒ a non-BYPASSRLS role is denied outright.
    await expect(appRole`SELECT seq FROM operator_audit_log LIMIT 1`).rejects.toThrow(/permission denied/i)
    await expect(appRole`INSERT INTO operator_audit_log (seq, actor, action, target, at, prev_hash, hash) VALUES (999999, 'x', 'x', '', 'x', '', 'x')`).rejects.toThrow(/permission denied/i)
  })

  it('detects a tampered entry (hash chain integrity)', async () => {
    const { entries } = await readOperatorChain(admin)
    expect(entries.length).toBeGreaterThan(0)
    // Mutate a stored field in-memory (no DB pollution) → the recomputed hash no longer matches.
    const tampered = entries.map((e, i) => (i === entries.length - 1 ? { ...e, action: 'HACKED' } : e))
    expect(verifyAuditChain(tampered).valid).toBe(false)
  })
})

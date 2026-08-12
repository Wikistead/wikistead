// #692 D: one positive assertion for "this operation reaches the compliance ledger" that is TRUE in
// both compositions. The ledger is EE (#688): on the dev suite the setup registers the sink and an
// audited operation leaves rows; on the CE build nothing registers and `auditIfEntitled` is a
// documented no-op. A test that hard-codes the composed count is red exactly where the product is
// right — and excluding the whole file would throw away the nine-tenths of it that IS the mirror's
// coverage. So the expectation asks the same predicate production asks (`auditLedgerRegistered()`)
// and pins BOTH answers: n rows when a ledger is composed in, zero when it is not — the CE no-op is
// a promise too, and this is where it gets measured.
//
// NO EE import here, deliberately: this helper must load in the CE build (the drain helper next door
// imports @wikistead-ee/server and is derived OUT of the mirror along with every file that uses it).
import { expect } from 'vitest'
import type { Sql } from 'postgres'
import { auditLedgerRegistered } from '../../audit/sink.js'

/**
 * Drain the audit outbox for `tenantId` — when a ledger is composed in at all. The real drain lives
 * beside the EE package (audit-drain.ts imports it), so it is reached by DYNAMIC import here: the
 * mirror derivation matches `from '…'` import syntax only, this call never executes in the CE build
 * (nothing registered → nothing enqueued → nothing to drain), and the file it names does not ship
 * there either.
 */
export async function drainLedgerFor(sql: Sql, tenantId: string): Promise<void> {
  if (!auditLedgerRegistered()) return
  const { drainAuditFor } = await import('./audit-drain.js')
  await drainAuditFor(sql, tenantId)
}

/** The row count an audited operation should have produced under the CURRENT composition. */
export function ledgerRows(n: number): number {
  return auditLedgerRegistered() ? n : 0
}

/**
 * Assert `count()` answers `n` under a composed ledger and `0` under none. The count stays a closure
 * because every caller filters differently (action, target, actor) — the helper owns the composition
 * arithmetic, the caller owns the predicate.
 */
export async function expectLedger(count: () => Promise<number>, n: number, what: string): Promise<void> {
  expect(await count(), `${what} (ledger ${auditLedgerRegistered() ? 'composed: expected ' + n : 'not composed: expected 0'})`).toBe(ledgerRows(n))
}

/**
 * The at-least form, for operations whose exact event count is not the test's subject (a convergence
 * pass revokes however many rows it finds). Still POSITIVE in both compositions: at least `n` under a
 * composed ledger, exactly zero under none — never `>= 0`, which would be green everywhere and
 * measure nothing.
 */
export async function expectLedgerAtLeast(count: () => Promise<number>, n: number, what: string): Promise<void> {
  const got = await count()
  if (auditLedgerRegistered()) expect(got, what).toBeGreaterThanOrEqual(n)
  else expect(got, `${what} (no ledger composed: the no-op must stay silent)`).toBe(0)
}

// #547 / ADR-196 §5: the email outbox — enqueue + drain over the ONE shared lease primitive (#432).
//
// S1 ships the INFRASTRUCTURE: the queue, the claim/retry/drop shape (webhook_outbox's), tenant and
// address resolution, and the per-class BUILDER registry the delivery classes plug into (S2: mention;
// S4: digest). A row whose class has no registered builder — or whose tenant/member/address is gone —
// drops immediately with a logged reason: the #482 rule, nothing may poison the queue head. Content
// is never stored on the row; the builder constructs the message at send time behind the ADR-196 §4
// gates it owns.
import { resolveTenantEmailDriver, type EmailDriver, type EmailMessage } from '@wikistead/hooks'
import { pool } from '../db/pool.js'
import { claimOutboxBatch, startOutboxDrainWorker } from '../db/outbox-lease.js'
import { withTenantTx } from '../db/with-tenant.js'

export interface EmailOutboxRow {
  id: string
  tenant_id: string
  member_sub: string
  class: string
  notification_id: string | null
  fold_key: string | null
  attempts: number
}

const MAX_ATTEMPTS = 8
const BACKOFF_BASE_S = 30

// A builder turns claimed rows (the fold group for one message) into ONE message, or a skip with a
// reason. It owns the ADR-196 §4 send-time gates; `suppress` maps to skip (the rows are done),
// `not-ready` maps to retry (the caller keeps the attempts budget).
export type EmailBuildResult =
  | { kind: 'send'; message: Omit<EmailMessage, 'to'> }
  | { kind: 'skip'; reason: string }
  | { kind: 'retry'; reason: string }
// #575 / ADR-200 slice B: the builders also get the tenant's BRANDING. It is resolved here, beside
// tenant and baseUrl, for the reason `outbox.ts` already records above: `tenant_settings` is RLS'd, so
// a bare-pool read from a builder answers empty and every mail would silently wear the deployment
// default. Resolving it once per row also means one read instead of one per builder.
export interface EmailBranding { productName: string; displayName: string | null; logoUrl: string | null; whitelabel: boolean }
export type EmailBuilder = (rows: EmailOutboxRow[], ctx: { tenantId: string; baseUrl: string | null; branding: EmailBranding }) => Promise<EmailBuildResult>

const builders = new Map<string, EmailBuilder>()
export function registerEmailBuilder(cls: string, builder: EmailBuilder): void {
  builders.set(cls, builder)
}

export async function enqueueEmailOutbox(rows: {
  tenantId: string
  memberSub: string
  class: string
  notificationId?: string | null
  foldKey?: string | null
  notBefore?: Date | null
}[]): Promise<void> {
  if (rows.length === 0) return
  for (const r of rows) {
    // the DB clock is the only clock (a host-side `new Date()` ahead of the container's now() makes
    // the row silently not-due — measured while writing the S1 tests)
    await pool`
      INSERT INTO email_outbox (tenant_id, member_sub, class, notification_id, fold_key, next_attempt_at)
      VALUES (${r.tenantId}, ${r.memberSub}, ${r.class}, ${r.notificationId ?? null}, ${r.foldKey ?? null}, COALESCE(${r.notBefore ?? null}, now()))`
  }
}

const retryOrDrop = async (row: EmailOutboxRow, log: (m: string) => void, reason: string) => {
  if (row.attempts + 1 >= MAX_ATTEMPTS) {
    await pool`DELETE FROM email_outbox WHERE id = ${row.id}`
    log(`email outbox drop ${row.id} (${row.class}): retries exhausted after ${reason}`)
    return
  }
  const backoff = BACKOFF_BASE_S * Math.pow(2, row.attempts)
  await pool`UPDATE email_outbox SET attempts = attempts + 1, claimed_at = NULL, next_attempt_at = now() + (${backoff} || ' seconds')::interval WHERE id = ${row.id}`
}

const drop = async (ids: string[], log: (m: string) => void, reason: string) => {
  if (ids.length === 0) return
  await pool`DELETE FROM email_outbox WHERE id IN ${pool(ids)}`
  log(`email outbox drop ${ids.join(',')}: ${reason}`)
}

// One drain pass. External I/O (address lookup, driver send) runs OUTSIDE any transaction (#432).
// deps.fallback is the boot-time CE driver (SMTP or announced no-op); per-tenant resolution goes
// through the ADR-196 §7 resolver so a managed-sender tenant uses its own transport here too.
export async function drainEmailOutbox(deps: { fallback: EmailDriver; log?: (m: string) => void; batch?: number }): Promise<number> {
  const log = deps.log ?? (() => {})
  // Workspaces already explained this drain (Decision 5 — once per drain, not once per message).
  const unaddressed = new Set<string>()
  const rows = await claimOutboxBatch<EmailOutboxRow>({
    table: 'email_outbox',
    returning: ['id', 'tenant_id', 'member_sub', 'class', 'notification_id', 'fold_key', 'attempts'],
    batch: deps.batch ?? 20,
    orderBy: 'next_attempt_at',
    extraDue: pool`AND next_attempt_at <= now()`,
  })
  let handled = 0
  const done = new Set<string>() // fold groups consume same-batch siblings — never process one twice
  for (const row of rows) {
    if (done.has(row.id)) continue
    try {
      const builder = builders.get(row.class)
      if (!builder) { await drop([row.id], log, `no builder for class '${row.class}'`); handled++; continue }
      // tenant + recipient resolve through the registry / a SHORT tenant tx — the drain runs as the
      // app role, and a bare pool read of RLS'd tables (members) answers empty (measured: every row
      // dropped as 'member gone'). Same shape as the webhook drain's hook read (webhooks.ts).
      const { registry } = await import('../db/index.js')
      const tenant = await registry.findById(row.tenant_id)
      if (!tenant) { await drop([row.id], log, 'tenant gone'); handled++; continue }
      // recipient address resolves at SEND time (sub-keyed rows; an IdP-side address change is picked
      // up automatically — ADR-196 §7 keying note). Missing/deactivated member → drop, never retry.
      const members = await withTenantTx(tenant, async (tx) => tx<{ email: string | null; deactivated_at: Date | null }[]>`
        SELECT email, deactivated_at FROM members WHERE sub = ${row.member_sub}`)
      if (members.length === 0) { await drop([row.id], log, 'member gone'); handled++; continue }
      if (members[0]!.deactivated_at != null) { await drop([row.id], log, 'member deactivated'); handled++; continue }
      const to = members[0]!.email
      if (!to) { await drop([row.id], log, 'member has no address'); handled++; continue }
      const { tenantBaseUrl, noAddressReason } = await import('./base-url.js')
      const address = await withTenantTx(tenant, async (tx) => tenantBaseUrl(tx as never, { id: tenant.id, slug: tenant.slug }))
      const baseUrl = address.url
      // #828 / ADR-254 Decision 5: a deployment that cannot address its mail says so WHEN IT HAPPENS
      // — not at boot, where the predicate would have to sweep `custom_domains` across every tenant
      // and would go stale the moment one is verified. Once per drain per workspace, not once per
      // message: in a drain of twenty the cause is the same twenty times, and a log that repeats it
      // reads as twenty problems.
      if (baseUrl === null && !unaddressed.has(tenant.id)) {
        unaddressed.add(tenant.id)
        log(`email outbox: ${tenant.slug} has no address for links — ${noAddressReason(address)}`)
      }
      // #575 slice B: the same short tenant tx shape — inside it because tenant_settings is FORCE RLS.
      const { getTenantBranding } = await import('../routes/branding.js')
      const { productName } = await import('../product-name.js')
      const b = await withTenantTx(tenant, async (tx) => getTenantBranding({ sql: tx } as never, tenant.plan))
      const branding = { productName: productName(), displayName: b.displayName, logoUrl: b.logoUrl, whitelabel: b.whitelabel }
      // fold (§6): gather this key's DUE siblings so K pending rows become one message. The advisory
      // lock serializes competing workers on the key; rows claimed here are marked so the batch that
      // claimed them elsewhere skips them (claimed_at was just refreshed by our claim).
      let group = [row]
      if (row.fold_key != null) {
        const siblings = await pool<EmailOutboxRow[]>`
          UPDATE email_outbox SET claimed_at = now()
          WHERE id IN (
            SELECT id FROM email_outbox
            WHERE fold_key = ${row.fold_key} AND id <> ${row.id} AND next_attempt_at <= now()
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, tenant_id, member_sub, class, notification_id, fold_key, attempts`
        group = [row, ...siblings]
      }
      for (const g of group) done.add(g.id)
      const built = await builder(group, { tenantId: tenant.id, baseUrl, branding })
      if (built.kind === 'skip') { await drop(group.map((g) => g.id), log, `builder skip: ${built.reason}`); handled++; continue }
      if (built.kind === 'retry') { for (const g of group) await retryOrDrop(g, log, built.reason); handled++; continue }
      const driver = resolveTenantEmailDriver({ tenantId: tenant.id, plan: String(tenant.plan) }, deps.fallback)
      await driver.send({ to, ...built.message })
      await pool`DELETE FROM email_outbox WHERE id IN ${pool(group.map((g) => g.id))}`
      handled++
    } catch (err) {
      await retryOrDrop(row, log, `send failed: ${err instanceof Error ? err.message : String(err)}`)
      handled++
    }
  }
  return handled
}

// Called from the server ENTRY (not buildApp) — tests drive drainEmailOutbox directly (#432 rule).
export function startEmailDrainWorker(deps: { fallback: EmailDriver; log?: (m: string) => void }, intervalMs: number): () => void {
  return startOutboxDrainWorker(() => drainEmailOutbox(deps), intervalMs)
}

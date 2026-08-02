// #547 / ADR-196 §2 §4 §5 (S4): the digest — a periodic per-member rollup of WATCH-derived
// notification rows (mention is the immediate class and never appears here).
//
// PRODUCER: an hourly tick that fires only at the deployment's configured hour (EMAIL_DIGEST_HOUR in
// EMAIL_DIGEST_TZ, default 08 UTC — a "fixed hour" without a timezone has bitten this codebase
// before). One pg advisory lock serializes the pass across replicas; `members.email_digest_last_at`
// makes it once-a-day idempotent across passes, and a pending-row check keeps a slow drain from
// accumulating duplicate jobs. A member is eligible when email_digest is ON, the #362 kill switch is
// not thrown, and un-emailed watch rows exist.
//
// BUILDER: per-ITEM disposition over the member's un-emailed watch rows —
//   suppress (private page, or the recipient's view denied by the inbox's own double gate) → stamped
//     emailed_at WITHOUT inclusion: consumed, never retried (revocation is not a race);
//   not-ready (page#space tuple not landed) → left unstamped: it rides the NEXT window, and never
//     blocks its confirmed siblings;
//   confirmed → included and stamped. An empty-after-confirmation digest is NOT sent.
// Stamping happens at build time, before the transport: under at-least-once this trades a transport
// failure losing that one digest against re-sending confirmed items as duplicates — the ADR picks
// "confirmed items are never re-sent".
import { fgaClient } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { acquireTenantDb, registry } from '../db/index.js'
import { pageEventDisposition } from '../page-disposition.js'
import { registerEmailBuilder, type EmailBuildResult, type EmailOutboxRow } from './outbox.js'
import type { EmailBranding } from './outbox.js'
import { startOutboxDrainWorker } from '../db/outbox-lease.js'

const DIGEST_PRODUCER_LOCK = 547_004

// One producer pass: enqueue at most one digest job per eligible member. Callable directly by tests;
// the worker below adds the fixed-hour cadence. members/notifications are RLS'd, so the pass walks
// tenants and reads each through its own SHORT tenant tx (the same lesson the drain learned: a bare
// pool read of an RLS'd table answers empty) — while ONE advisory xact lock on an outer connection
// serializes the whole pass across replicas.
export async function produceDigestJobs(log: (m: string) => void = () => {}): Promise<number> {
  return (await pool.begin(async (lockTx) => {
    await lockTx`SELECT pg_advisory_xact_lock(${DIGEST_PRODUCER_LOCK})`
    const tenants = await pool<{ id: string }[]>`SELECT id FROM tenants`
    let produced = 0
    const { withTenantTx } = await import('../db/index.js')
    for (const t of tenants) {
      const rows = await withTenantTx(t.id, async (tx) => tx<{ sub: string }[]>`
        SELECT m.sub FROM members m
        WHERE m.email_digest = true
          AND COALESCE(m.notifications_enabled, true)
          AND m.email IS NOT NULL
          AND (m.email_digest_last_at IS NULL OR m.email_digest_last_at < now() - interval '20 hours')
          AND EXISTS (
            SELECT 1 FROM notifications n JOIN feed_events f ON f.id = n.event_id
            WHERE n.member_sub = m.sub AND n.emailed_at IS NULL
              AND f.event_type <> 'mention')
          AND NOT EXISTS (
            SELECT 1 FROM email_outbox o
            WHERE o.tenant_id = ${t.id} AND o.member_sub = m.sub AND o.class = 'digest')`).catch(() => [] as { sub: string }[])
      for (const r of rows) {
        await withTenantTx(t.id, async (tx) => {
          await tx`INSERT INTO email_outbox (tenant_id, member_sub, class) VALUES (${t.id}, ${r.sub}, 'digest')`
          await tx`UPDATE members SET email_digest_last_at = now() WHERE sub = ${r.sub}`
        })
        produced += 1
      }
    }
    if (produced > 0) log(`digest producer: enqueued ${produced} job(s)`)
    return produced
  })) as number
}

const DIGEST_ITEM_CAP = 100

export async function buildDigestEmail(rows: EmailOutboxRow[], ctx: { tenantId: string; baseUrl: string | null; branding: EmailBranding }): Promise<EmailBuildResult> {
  const memberSub = rows[0]!.member_sub
  const tenant = await registry.findById(ctx.tenantId)
  if (!tenant) return { kind: 'skip', reason: 'tenant gone' }
  const db = await acquireTenantDb(tenant)
  try {
    const raw = await db.sql<{ nid: string; id: string; event_type: string; page_id: string | null; space_id: string | null; actor: string; created_at: Date }[]>`
      SELECT n.id AS nid, f.id, f.event_type, f.page_id, f.space_id, f.actor, f.created_at
      FROM notifications n JOIN feed_events f ON f.id = n.event_id
      WHERE n.member_sub = ${memberSub} AND n.emailed_at IS NULL AND f.event_type <> 'mention'
      ORDER BY f.created_at ASC LIMIT ${DIGEST_ITEM_CAP}`
    if (raw.length === 0) return { kind: 'skip', reason: 'empty digest (nothing new)' }

    // Stage 1, PER ITEM: page disposition. suppress → consume unstamped-included never; not-ready →
    // leave for the next window; deliver → candidate for the recipient gate.
    const dispByPage = new Map<string, 'suppress' | 'deliver' | 'not-ready'>()
    for (const pid of new Set(raw.filter((r) => r.page_id).map((r) => r.page_id!))) {
      dispByPage.set(pid, await pageEventDisposition(fgaClient, { pageId: pid }))
    }
    const consumed: string[] = [] // notification ids stamped WITHOUT inclusion
    const candidates: (typeof raw)[number][] = []
    for (const r of raw) {
      const d = r.page_id ? dispByPage.get(r.page_id)! : 'deliver'
      if (d === 'not-ready') continue // carries over, blocks nothing
      if (d === 'suppress') { consumed.push(r.nid); continue }
      candidates.push(r)
    }

    // Stage 2, recipient-level: the inbox's own double gate. Anything a candidate loses here is a
    // CONFIRMED loss of view → consumed, never retried.
    const { gateEvents } = await import('../routes/notifications.js')
    const gated = candidates.length
      ? await gateEvents(db, fgaClient, `user:${memberSub}`, candidates.map((r) => ({ id: r.id, event_type: r.event_type, page_id: r.page_id, space_id: r.space_id, actor: r.actor, created_at: r.created_at })))
      : []
    const gatedIds = new Set(gated.map((g) => g.id))
    for (const c of candidates) if (!gatedIds.has(c.id)) consumed.push(c.nid)

    const confirmedNids = candidates.filter((c) => gatedIds.has(c.id)).map((c) => c.nid)
    // stamp BEFORE transport (never re-send a confirmed item — the ADR's at-least-once choice)
    const stamp = [...consumed, ...confirmedNids]
    if (stamp.length) await db.sql`UPDATE notifications SET emailed_at = now() WHERE id = ANY(${stamp})`

    if (gated.length === 0) return { kind: 'skip', reason: 'empty after confirmation' }
    if (!ctx.baseUrl) return { kind: 'skip', reason: 'no WKS_PUBLIC_BASE_URL / custom domain — refusing to improvise links' }

    // minimal body: event type + send-time-confirmed live title + deep link. Never content or diffs.
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const lines = gated.map((g) => {
      const link = g.pageId ? `${ctx.baseUrl}/p/${g.pageId}` : `${ctx.baseUrl}/`
      return { label: `${g.eventType}: ${g.title ?? ''}`, link }
    })
    // #575 slice B: the digest wears the same shell as the mention mail — and gains the unsubscribe it
    // never had. The token's ACTION is `digest`: minting an `immediate` one here (the shape a copy of
    // the mention builder would produce) means "stop the digest" silently stops MENTIONS instead, which
    // is the one realistic bug in this area and is pinned as such.
    const { mintUnsubToken } = await import('@wikistead/auth')
    const { renderBrandedHtml, renderBrandedText, brandName } = await import('./layout.js')
    const unsubToken = await mintUnsubToken(
      { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: Number(process.env.UNSUB_TOKEN_TTL_S ?? 30 * 86400) },
      { tenantId: ctx.tenantId, sub: rows[0]!.member_sub, action: 'digest' },
    )
    const unsubUrl = `${ctx.baseUrl}/api/email/unsubscribe?token=${encodeURIComponent(unsubToken)}`
    return {
      kind: 'send',
      message: {
        subject: `[${brandName(ctx.branding)}] Your digest: ${gated.length} update${gated.length === 1 ? '' : 's'}`,
        text: renderBrandedText({
          branding: ctx.branding,
          body: lines.map((l) => `${l.label}\n${l.link}`).join('\n\n'),
          footer: `Stop these emails: ${unsubUrl}`,
        }),
        html: renderBrandedHtml({
          branding: ctx.branding, baseUrl: ctx.baseUrl,
          body: `<ul>${lines.map((l) => `<li>${esc(l.label)}: <a href="${esc(l.link)}">open</a></li>`).join('')}</ul>`,
          footer: `<a href="${esc(unsubUrl)}">Stop these emails</a>`,
        }),
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
    }
  } finally {
    await db.release()
  }
}

registerEmailBuilder('digest', buildDigestEmail)

// The cadence worker: ticks hourly, fires the producer only when the current hour in the deployment's
// timezone matches the configured hour. Called from the server ENTRY; tests call produceDigestJobs.
export function startDigestProducerWorker(log: (m: string) => void, intervalMs = 3_600_000): () => void {
  const due = (): boolean => {
    const hour = Number(process.env.EMAIL_DIGEST_HOUR ?? 8)
    const tz = process.env.EMAIL_DIGEST_TZ ?? 'UTC'
    const nowHour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date()))
    return nowHour === hour
  }
  return startOutboxDrainWorker(async () => (due() ? produceDigestJobs(log) : 0), intervalMs)
}

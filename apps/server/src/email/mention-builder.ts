// #547 / ADR-196 §4 (S2): the 'mention' delivery class. Builds ONE message from a fold group of
// mention outbox rows (same recipient, same page) — behind BOTH send-time gates:
//   Stage 1 (page-level): the shared tri-state disposition. For mention email `not-ready` maps to
//   SUPPRESS, not retry — a page unpublished AT BUILD TIME never mails, even if published inside what
//   would have been the retry window (the R2 determinism rule; the ruling: draft mentions stay
//   in-app). Private likewise suppresses. Fail-closed.
//   Stage 2 (recipient-level): gateEvents — the very double gate the inbox runs (live row + per-event
//   FGA view). A recipient-level deny is a CONFIRMED loss of view → suppress, never a retry
//   (revocation is not a race).
// The body is TITLE + LINK only (the Review ruling: no excerpt — an email is a permanent disclosure
// outside the fortress). No base URL configured → skip with a logged reason (an honest drop beats an
// improvised link).
import { fgaClient } from '@wikistead/authz'
import { mintUnsubToken } from '@wikistead/auth'
import { acquireTenantDb, registry } from '../db/index.js'
import { pageEventDisposition } from '../page-disposition.js'
import { registerEmailBuilder, type EmailBuildResult, type EmailOutboxRow } from './outbox.js'
import type { EmailBranding } from './outbox.js'

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export async function buildMentionEmail(rows: EmailOutboxRow[], ctx: { tenantId: string; baseUrl: string | null; branding: EmailBranding }): Promise<EmailBuildResult> {
  const ids = rows.map((r) => r.notification_id).filter((v): v is string => v != null)
  if (ids.length === 0) return { kind: 'skip', reason: 'no notification ids on mention rows' }
  const tenant = await registry.findById(ctx.tenantId)
  if (!tenant) return { kind: 'skip', reason: 'tenant gone' }
  const db = await acquireTenantDb(tenant)
  try {
    // the parent notification rows are the ONLY source (ADR-196 §1) — gone rows (feed retention,
    // deleted) mean there is nothing to say
    const raw = await db.sql<{ id: string; event_type: string; page_id: string | null; space_id: string | null; actor: string; created_at: Date; member_sub: string }[]>`
      SELECT f.id, f.event_type, f.page_id, f.space_id, f.actor, f.created_at, n.member_sub
      FROM notifications n JOIN feed_events f ON f.id = n.event_id
      WHERE n.id = ANY(${ids})`
    if (raw.length === 0) return { kind: 'skip', reason: 'parent notification rows gone' }
    const pageId = raw[0]!.page_id
    if (!pageId) return { kind: 'skip', reason: 'mention without a page' }

    // Stage 1 — page disposition; not-ready is SUPPRESS for mention (R2, deterministic draft rule)
    const disp = await pageEventDisposition(fgaClient, { pageId })
    if (disp !== 'deliver') return { kind: 'skip', reason: `page disposition ${disp} (draft/private mentions stay in-app)` }

    // Stage 2 — the recipient's own double gate (live row + FGA view), the inbox's authority
    const gated = await (await import('../routes/notifications.js')).gateEvents(
      db, fgaClient, `user:${rows[0]!.member_sub}`,
      raw.map((r) => ({ id: r.id, event_type: r.event_type, page_id: r.page_id, space_id: r.space_id, actor: r.actor, created_at: r.created_at })),
    )
    if (gated.length === 0) return { kind: 'skip', reason: 'recipient view denied at send time (suppress, never retry)' }

    // #828 / ADR-254 Decision 5: the reason stops naming a variable. WHICH addressing step ran out is
    // said once per drain by the drain itself, which is the only place that knows; repeating a guess
    // at it once per message is how the old string came to name the wrong one.
    if (!ctx.baseUrl) return { kind: 'skip', reason: 'no address for this workspace — refusing to improvise a link' }
    const title = gated[0]!.title ?? 'a page'
    const link = `${ctx.baseUrl}/p/${pageId}`
    const more = gated.length > 1 ? ` (and ${gated.length - 1} more)` : ''
    // #547 S3: the RFC 8058 unsubscribe — a tenant-bound unsub+jwt in the link; GET confirms, the
    // one-click POST (List-Unsubscribe-Post) flips exactly this member's email_immediate pref.
    const unsubToken = await mintUnsubToken(
      { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: Number(process.env.UNSUB_TOKEN_TTL_S ?? 30 * 86400) },
      { tenantId: ctx.tenantId, sub: rows[0]!.member_sub, action: 'immediate' },
    )
    const unsubUrl = `${ctx.baseUrl}/api/email/unsubscribe?token=${encodeURIComponent(unsubToken)}`
    // TITLE + LINK ONLY — never the comment body, never an excerpt (the Review ruling)
    // #575 slice B: the shared branded shell. Still TITLE + LINK only — branding changes who the mail
    // is FROM, never how much of the content it carries.
    const { renderBrandedHtml, renderBrandedText, brandName } = await import('./layout.js')
    return {
      kind: 'send',
      message: {
        subject: `[${brandName(ctx.branding)}] You were mentioned in "${title}"${more}`,
        text: renderBrandedText({
          branding: ctx.branding,
          body: `You were mentioned in "${title}"${more}.\n\nOpen the page:\n${link}`,
          footer: `Stop these emails: ${unsubUrl}`,
        }),
        html: renderBrandedHtml({
          branding: ctx.branding, baseUrl: ctx.baseUrl,
          body: `<p>You were mentioned in <strong>${esc(title)}</strong>${esc(more)}.</p><p><a href="${esc(link)}">Open the page</a></p>`,
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

registerEmailBuilder('mention', buildMentionEmail)

// #547 / ADR-196 (S2): mention email rides the notification row through the outbox — and the legacy
// direct send in comments.ts is gone. The ADR's anti-tests, driven end to end on the real stack:
//   - one mention → exactly one outbox row per recipient → one mail, TITLE + LINK only (never the
//     comment body — the Review ruling: an email is a permanent disclosure outside the fortress);
//   - the #362 kill switch and the email_immediate pref silence it (today's bug, named and fixed);
//   - a DRAFT mention stays in-app: suppress at build time, and publishing later does not
//     retroactively send (deterministic, never timing-dependent — R2);
//   - a recipient whose view was revoked between fan-out and send gets nothing (suppress, no retry);
//   - K mentions inside the fold window → ONE message with a folded count.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { registerEmailDriver, registerEmailDriverResolver, type EmailMessage } from '@wikistead/hooks'
import { createSpace, deleteSpace, grantSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { fanOutMention } from '../routes/notifications.js'
import { drainEmailOutbox } from '../email/outbox.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'
const R1 = `me-r1-${STAMP}` // the ordinary recipient
const R2 = `me-r2-${STAMP}` // kill switch off
const R3 = `me-r3-${STAMP}` // email_immediate off
const R4 = `me-r4-${STAMP}` // view revoked between fan-out and send

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''
const COMMENT_BODY = `secret comment body ${STAMP} that must never reach a mailbox`

let sent: EmailMessage[] = []
const capture = { send: async (m: EmailMessage) => { sent.push(m) } }
const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

beforeAll(async () => {
  process.env.WKS_PUBLIC_BASE_URL = 'http://base547.test'
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `me-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `Mention Target ${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  for (const sub of [R1, R2, R3, R4]) {
    await adminPool`INSERT INTO members (tenant_id, sub, display_name, email) VALUES (${TENANT}, ${sub}, ${sub}, ${`${sub}@t.test`})`
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: `user:${sub}`, capability: 'view', plan: 'business' })
  }
  await adminPool`UPDATE members SET notifications_enabled = false WHERE tenant_id = ${TENANT} AND sub = ${R2}`
  await adminPool`UPDATE members SET email_immediate = false WHERE tenant_id = ${TENANT} AND sub = ${R3}`
}, 120_000)

afterAll(async () => {
  delete process.env.WKS_PUBLIC_BASE_URL
  await adminPool`DELETE FROM email_outbox WHERE tenant_id = ${TENANT} AND member_sub LIKE ${'me-r%-' + STAMP}`.catch(() => {})
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub LIKE ${'me-r%-' + STAMP}`.catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await adminPool`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

beforeEach(() => {
  sent = []
  registerEmailDriverResolver(() => null)
  // @ts-expect-error deliberate reset of the boot-time slot
  registerEmailDriver(null)
})

const outboxOf = (sub: string) => adminPool<{ id: string; class: string; notification_id: string | null }[]>`
  SELECT id, class, notification_id FROM email_outbox WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`
const forceDue = (sub: string) => adminPool`UPDATE email_outbox SET next_attempt_at = now() - interval '1 second' WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`
const drain = () => drainEmailOutbox({ fallback: capture, log: () => {}, batch: 50 })
const mention = (subs: string[]) => app.inject({
  method: 'POST', url: `/pages/${pageId}/comments`, headers: dev,
  payload: { body: COMMENT_BODY, mentions: subs },
})

describe('#547 S2: mention email through the outbox', () => {
  it('one mention → one thin row → one mail with TITLE + LINK and NEVER the comment body', async () => {
    const res = await mention([R1])
    expect(res.statusCode).toBeLessThan(300)
    const rows = await outboxOf(R1)
    expect(rows.length, 'exactly one outbox row (the legacy direct send is gone)').toBe(1)
    expect(rows[0]!.class).toBe('mention')
    await forceDue(R1)
    await drain()
    expect(sent.length, 'one mail').toBe(1)
    expect(sent[0]!.to).toBe(`${R1}@t.test`)
    expect(sent[0]!.subject).toContain(`Mention Target ${STAMP}`)
    // the base may be a VERIFIED custom domain (it wins over the env — other suites register one for
    // tenant_dev), so the pin is the shape: an absolute link to THIS page
    expect(sent[0]!.text).toMatch(new RegExp(`https?://[^\\s]+/p/${pageId}`))
    for (const field of [sent[0]!.subject, sent[0]!.text, sent[0]!.html]) {
      expect(field, 'the comment body never reaches a mailbox').not.toContain('secret comment body')
    }
    // #547 S3: the RFC 8058 one-click headers ride every mention mail
    expect(sent[0]!.headers?.['List-Unsubscribe'], 'the unsubscribe link header').toContain('/api/email/unsubscribe?token=')
    expect(sent[0]!.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect((await outboxOf(R1)).length).toBe(0)
  }, 120_000)

  it('the #362 kill switch silences mention email (today it did not — the named bug)', async () => {
    await mention([R2])
    expect((await outboxOf(R2)).length, 'no outbox row for a killed-switch member').toBe(0)
    const n = await adminPool<{ id: string }[]>`
      SELECT n.id FROM notifications n JOIN members m ON m.tenant_id = n.tenant_id AND m.sub = n.member_sub WHERE n.member_sub = ${R2}`
    expect(n.length, 'no in-app row either (the switch kills the emission, email inherits)').toBe(0)
  }, 120_000)

  it('email_immediate=false: the in-app row arrives, the mail does not', async () => {
    await mention([R3])
    const n = await adminPool<{ id: string }[]>`SELECT id FROM notifications WHERE tenant_id = ${TENANT} AND member_sub = ${R3}`
    expect(n.length, 'the inbox still gets it').toBeGreaterThan(0)
    expect((await outboxOf(R3)).length, 'no email row').toBe(0)
  }, 120_000)

  it('a DRAFT mention suppresses at build, and publishing later does not resurrect it', async () => {
    const draftId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `Draft ${STAMP}` })).id
    try {
      await db.tx((tx) => fanOutMention(tx, { tenantId: TENANT, pageId: draftId, spaceId, actor: `user:${OWNER}`, recipientSubs: [R1] }))
      expect((await outboxOf(R1)).length, 'the row enqueues (fan-out is draft-inclusive in-app)').toBe(1)
      await forceDue(R1)
      await drain()
      expect(sent.length, 'no mail for a draft (suppress, not retry)').toBe(0)
      expect((await outboxOf(R1)).length, 'the row is consumed, not parked for retry').toBe(0)
      await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: draftId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
      await drain()
      expect(sent.length, 'publishing later cannot resurrect the suppressed mail').toBe(0)
    } finally {
      await deletePage(db, fgaClient, app.searchDriver, { pageId: draftId, userId: OWNER }).catch(() => {})
    }
  }, 120_000)

  it('a recipient revoked between fan-out and send gets nothing (suppress, never retry)', async () => {
    await mention([R4])
    expect((await outboxOf(R4)).length).toBe(1)
    const { revokeSpaceAccess } = await import('../routes/spaces.js')
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: `user:${R4}`, capability: 'view', plan: 'business' })
    await forceDue(R4)
    await drain()
    expect(sent.length, 'no mail after revocation').toBe(0)
    expect((await outboxOf(R4)).length, 'dropped, not retried — revocation is not a race').toBe(0)
  }, 120_000)

  it('K mentions inside the window fold into ONE message with a count', async () => {
    await mention([R1])
    await mention([R1])
    const rows = await outboxOf(R1)
    expect(rows.length, 'two pending rows share the fold key').toBe(2)
    await forceDue(R1)
    await drain()
    expect(sent.length, 'one folded mail').toBe(1)
    expect(sent[0]!.subject).toContain('and 1 more')
    expect((await outboxOf(R1)).length).toBe(0)
  }, 120_000)

  it('lexical: the legacy direct send stays deleted from comments.ts', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../routes/comments.ts', import.meta.url), 'utf8')
    expect(src, 'no direct mention email send in the comment path').not.toContain('You were mentioned in a comment')
    expect(src).not.toMatch(/email\s*\n?\s*\.send\(/)
  })
})

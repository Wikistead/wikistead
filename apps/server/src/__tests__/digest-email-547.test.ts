// #547 / ADR-196 §2 §4 §5 (S4): the digest. The ADR's anti-tests on the real stack:
//   - a digest-opted watcher gets ONE rollup (event type + live title + link, never content); items
//     stamped emailed_at are never re-sent; the producer is once-a-day idempotent;
//   - PER-ITEM disposition: a not-ready item rides the next window while its confirmed siblings send;
//     a suppressed item (private page) is consumed silently; empty-after-confirmation is not sent;
//   - email_digest=false (the default) members get nothing despite watching.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { registerEmailDriver, registerEmailDriverResolver, type EmailMessage } from '@wikistead/hooks'
import { createSpace, deleteSpace, grantSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { fanOutFeedEvent } from '../routes/notifications.js'
import { drainEmailOutbox } from '../email/outbox.js'
import { produceDigestJobs } from '../email/digest.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'
const W1 = `dg-w1-${STAMP}` // digest-opted watcher
const W2 = `dg-w2-${STAMP}` // default (digest off)

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageA = ''
let pageB = ''

let sent: EmailMessage[] = []
const capture = { send: async (m: EmailMessage) => { sent.push(m) } }

beforeAll(async () => {
  process.env.WKS_PUBLIC_BASE_URL ??= 'http://dg547.test'
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `dg-${STAMP}` })).id
  pageA = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `Digest A ${STAMP}` })).id
  pageB = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `Digest B ${STAMP}` })).id
  for (const p of [pageA, pageB]) await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: p, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  for (const sub of [W1, W2]) {
    await adminPool`INSERT INTO members (tenant_id, sub, display_name, email) VALUES (${TENANT}, ${sub}, ${sub}, ${`${sub}@t.test`})`
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: `user:${sub}`, capability: 'view', plan: 'business' })
    await adminPool`INSERT INTO watches (tenant_id, member_sub, resource_type, resource_id) VALUES (${TENANT}, ${sub}, 'space', ${spaceId})`
  }
  await adminPool`UPDATE members SET email_digest = true WHERE tenant_id = ${TENANT} AND sub = ${W1}`
}, 120_000)

afterAll(async () => {
  await adminPool`DELETE FROM email_outbox WHERE tenant_id = ${TENANT} AND member_sub LIKE ${'dg-w%-' + STAMP}`.catch(() => {})
  await adminPool`DELETE FROM watches WHERE tenant_id = ${TENANT} AND member_sub LIKE ${'dg-w%-' + STAMP}`.catch(() => {})
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub LIKE ${'dg-w%-' + STAMP}`.catch(() => {})
  for (const p of [pageA, pageB]) await deletePage(db, fgaClient, app.searchDriver, { pageId: p, userId: OWNER }).catch(() => {})
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

// #853: the digest body prints the stored `eventType` verbatim (`digest.ts`: `${eventType}: ${title}`),
// so a fixture that stores a string the product never writes is measuring prose no reader will see.
// Measured, shipped code writes six values into `feed_events` — page.published, page.restored,
// page.made_public, page.made_non_public, comment.created, attachment.confirmed — and `page.updated`
// is not among them. It was the DomainEvent name #862 split into page.renamed and page.moved; this
// fixture kept it because `feed_events.event_type` is a bare string with no union to fail on.
const emitPublished = (pageId: string) =>
  db.tx((tx) => fanOutFeedEvent(tx, { tenantId: TENANT, eventType: 'page.published', pageId, spaceId, actor: 'user:someone-else', publishedAt: new Date(), log: { warn: () => {} } }))
const outboxOf = (sub: string) => adminPool<{ id: string }[]>`SELECT id FROM email_outbox WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`
const resetDaily = () => adminPool`UPDATE members SET email_digest_last_at = NULL WHERE tenant_id = ${TENANT} AND sub = ${W1}`
const forceDue = () => adminPool`UPDATE email_outbox SET next_attempt_at = now() - interval '1 second' WHERE tenant_id = ${TENANT} AND member_sub LIKE ${'dg-w%-' + STAMP}`
const drain = () => drainEmailOutbox({ fallback: capture, log: () => {}, batch: 50 })

describe('#547 S4: digest', () => {
  it('one rollup per opted member; items are never re-sent; the producer is once-a-day idempotent', async () => {
    await emitPublished(pageA)
    await emitPublished(pageB)
    const produced = await produceDigestJobs()
    expect(produced, 'exactly one job (W1); the default-off watcher produces nothing').toBe(1)
    expect((await outboxOf(W2)).length, 'email_digest=false: nothing despite watching').toBe(0)
    expect(await produceDigestJobs(), 'a second pass in the same day enqueues nothing').toBe(0)
    await forceDue()
    await drain()
    expect(sent.length).toBe(1)
    expect(sent[0]!.to).toBe(`${W1}@t.test`)
    expect(sent[0]!.subject).toContain('2 update')
    expect(sent[0]!.text).toContain(`Digest A ${STAMP}`)
    expect(sent[0]!.text).toContain(`Digest B ${STAMP}`)
    // #900: the body says what happened in words. ⚠️ Asserted as the ABSENCE of a dotted identifier
    // rather than as the presence of a phrase — pinning the phrase would freeze prose that is meant
    // to be rewritten (the mail surface has no i18n yet), and would go green again the moment
    // somebody reintroduced `${'${'}eventType}` beside it.
    for (const line of sent[0]!.text.split('\n')) {
      const before = line.split(':')[0] ?? ''
      expect(/^[a-z_]+\.[a-z_]+$/.test(before.trim()), `an internal identifier reached the reader: ${line}`).toBe(false)
    }
    expect(sent[0]!.text).toContain(`/p/${pageA}`)
    // consumed: a re-produce (daily guard lifted) finds nothing new
    await resetDaily()
    expect(await produceDigestJobs(), 'stamped items never rebuild a digest').toBe(0)
  }, 120_000)

  it('per-item: a not-ready item rides the next window while confirmed siblings send', async () => {
    await emitPublished(pageA)
    await emitPublished(pageB)
    // constructed not-ready state (the ADR names this a defensive state with no realistic e2e
    // trigger): pull pageB's space link so its disposition is not-ready at build time
    const linkTuple = [{ user: `space:${spaceId}`, relation: 'space', object: `page:${pageB}` }]
    await deleteTuples(fgaClient, linkTuple)
    await resetDaily()
    expect(await produceDigestJobs()).toBe(1)
    await forceDue()
    await drain()
    expect(sent.length, 'the confirmed sibling sends').toBe(1)
    expect(sent[0]!.text).toContain(`Digest A ${STAMP}`)
    expect(sent[0]!.text, 'the not-ready item is NOT in this digest').not.toContain(`Digest B ${STAMP}`)
    // restore the link → the carried-over item arrives in the NEXT window, alone
    await writeTuples(fgaClient, linkTuple)
    await resetDaily()
    sent = []
    expect(await produceDigestJobs(), 'the carried item re-produces').toBe(1)
    await forceDue()
    await drain()
    expect(sent.length).toBe(1)
    expect(sent[0]!.text, 'the once-not-ready item arrives').toContain(`Digest B ${STAMP}`)
    expect(sent[0]!.text, 'its confirmed sibling is NOT re-sent').not.toContain(`Digest A ${STAMP}`)
  }, 120_000)

  it('suppressed items are consumed silently; an empty-after-confirmation digest is not sent', async () => {
    const { setPagePrivate } = await import('../routes/pages.js')
    await emitPublished(pageA)
    await setPagePrivate(db, fgaClient, app.searchDriver, { pageId: pageA, tenantId: TENANT, userId: OWNER, plan: 'business' })
    try {
      await resetDaily()
      expect(await produceDigestJobs(), 'the job produces (the row exists)').toBe(1)
      await forceDue()
      await drain()
      expect(sent.length, 'nothing sends — the only item was private (suppress)').toBe(0)
      expect((await outboxOf(W1)).length, 'the job is consumed, not parked').toBe(0)
      await resetDaily()
      expect(await produceDigestJobs(), 'the suppressed item was consumed — no rebuild').toBe(0)
    } finally {
      const { unsetPagePrivate } = await import('../routes/pages.js')
      await unsetPagePrivate(db, fgaClient, app.searchDriver, { pageId: pageA, tenantId: TENANT, userId: OWNER, plan: 'business' }).catch(() => {})
    }
  }, 120_000)

  // #900: the rows the label table does not name. `feed_events.event_type` is plain text, so a value
  // written before the union existed -- or by a path that bypasses `fanOutFeedEvent` -- still reaches
  // the body. ⚠️ The other cases in this file only ever create the six kinds the table names, so they
  // cannot see this branch at all: measured, restoring the identifier fallback left every one of them
  // green. The row is therefore written straight to the table, the way a legacy row exists.
  it('an event kind the table does not name still reaches the reader in words', async () => {
    const legacy = 'page.frobnicated'
    const [ev] = await adminPool<{ id: string }[]>`
      INSERT INTO feed_events (tenant_id, event_type, page_id, space_id, actor)
      VALUES (${TENANT}, ${legacy}, ${pageA}, ${spaceId}, ${'user:someone-else'}) RETURNING id`
    await adminPool`
      INSERT INTO notifications (tenant_id, member_sub, event_id) VALUES (${TENANT}, ${W1}, ${ev!.id})`
    await resetDaily()
    expect(await produceDigestJobs(), 'the unnamed kind still produces a digest').toBe(1)
    await forceDue()
    await drain()
    expect(sent.length).toBe(1)
    expect(sent[0]!.text, 'the identifier does not reach the inbox').not.toContain(legacy)
    expect(sent[0]!.text, 'and the item is still there, described').toContain(`Digest A ${STAMP}`)
  }, 120_000)
})

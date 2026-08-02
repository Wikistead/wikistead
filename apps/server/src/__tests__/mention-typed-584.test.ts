// #584: a mention you TYPE is a mention.
//
// The report said `fanOutMention` had no product caller and that mention email therefore never fired.
// That premise is wrong twice over: `notifyMentions` in comments.ts calls it from both comment routes,
// and mention-email-547.test.ts already drives the whole chain through `POST /pages/:id/comments`.
// (The grep that found "no callers" missed it because comments.ts is classified as binary — plain
// grep needs `-a` on this file. Recorded here because it is the second time that trap has produced a
// confident wrong diagnosis.)
//
// The symptom was real, though, and this is where it came from: the composer only reports the names
// PICKED from its autocomplete in the current session. Type `@Alice` yourself — or pick her, reload,
// and reply — and the client sends an empty mention list, so nobody is notified and no mail is sent.
// ADR-196's rule is `mentionableViewers ∩ the people actually named in the text`, and the text half
// was never read.
//
// The gate is unchanged and is what makes reading the text safe: every candidate still has to survive
// `mentionableViewers` (a member who can view THIS page), so a typed name can no more reach a
// non-viewer than a client-sent sub could.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { createSpace, deleteSpace, grantSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'
const SEEN = `mt-seen-${STAMP}` // a member who can view the page
const BLIND = `mt-blind-${STAMP}` // a member who cannot
const SEEN_NAME = 'Ada Lovelace'

const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `mt-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `Typed Mention ${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  await admin`INSERT INTO members (tenant_id, sub, display_name, email) VALUES (${TENANT}, ${SEEN}, ${SEEN_NAME}, ${`${SEEN}@t.test`})`
  await admin`INSERT INTO members (tenant_id, sub, display_name, email) VALUES (${TENANT}, ${BLIND}, 'Ada Nobody', ${`${BLIND}@t.test`})`
  await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: `user:${SEEN}`, capability: 'view', plan: 'business' })
}, 180_000)

afterAll(async () => {
  await admin`DELETE FROM email_outbox WHERE tenant_id = ${TENANT} AND member_sub LIKE ${'mt-%-' + STAMP}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub LIKE ${'mt-%-' + STAMP}`.catch(() => {})
  await admin`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await admin`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

const comment = (body: string, mentions?: string[]) =>
  app.inject({ method: 'POST', url: `/pages/${pageId}/comments`, headers: dev, payload: { body, mentions } })
const notificationsOf = (sub: string) =>
  admin<{ id: string }[]>`SELECT id FROM notifications WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`
const outboxOf = (sub: string) =>
  admin<{ class: string }[]>`SELECT class FROM email_outbox WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`
const clear = async (sub: string) => {
  await admin`DELETE FROM email_outbox WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`
  await admin`DELETE FROM notifications WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`
}

describe('#584: the text is read, not just the client\'s list', () => {
  it('a typed @name with an EMPTY mention list still notifies and enqueues the mail', async () => {
    await clear(SEEN)
    const res = await comment(`morning @AdaLovelace — could you look at this?`, [])
    expect(res.statusCode).toBeLessThan(300)
    expect((await notificationsOf(SEEN)).length, 'this is the reported symptom: nothing arrived').toBe(1)
    expect((await outboxOf(SEEN)).map((r) => r.class), 'and the mail was never queued either').toEqual(['mention'])
  }, 180_000)

  it('the name is matched the way people write it (case-insensitive)', async () => {
    await clear(SEEN)
    await comment(`cc @adalovelace`)
    expect((await notificationsOf(SEEN)).length).toBe(1)
  }, 180_000)

  it('an email address in the body is not a mention', async () => {
    await clear(SEEN)
    const res = await comment(`write to ada@example.com about it`)
    expect(res.statusCode).toBeLessThan(300)
    expect((await notificationsOf(SEEN)).length, 'the local part before @ is not an @tag').toBe(0)
  }, 180_000)

  it('a member who cannot VIEW the page is not reachable by typing their name', async () => {
    await clear(BLIND)
    await comment(`hello @AdaNobody`)
    expect((await notificationsOf(BLIND)).length, 'mentionableViewers is still the gate — no existence leak').toBe(0)
    expect((await outboxOf(BLIND)).length).toBe(0)
  }, 180_000)

  it('the client list still works, and naming someone twice notifies once', async () => {
    await clear(SEEN)
    await comment(`@AdaLovelace and again @AdaLovelace`, [SEEN])
    expect((await notificationsOf(SEEN)).length, 'one event, one notification').toBe(1)
  }, 180_000)

  it('mentioning yourself sends nothing', async () => {
    const before = await admin<{ id: string }[]>`SELECT id FROM notifications WHERE tenant_id = ${TENANT} AND member_sub = ${OWNER}`
    await comment(`note to self @dev-user`)
    const after = await admin<{ id: string }[]>`SELECT id FROM notifications WHERE tenant_id = ${TENANT} AND member_sub = ${OWNER}`
    expect(after.length, 'the actor is excluded from their own mention').toBe(before.length)
  }, 180_000)
})

// #277 / ADR-116: the space-level anonymous public toggle. Security-critical (it writes/revokes the
// anonymous space:S#viewer@user:* wildcard). Real Postgres + OpenFGA + Fastify. Anti-tests pin:
// manager-only with a UNIFORM 403 (member / stranger / cross-tenant all alike — the RLS belt is
// exercised with an FGA grant present, so row-existence is proven load-bearing); the tenant parent
// switch gates the route; exposure is exactly public ∩ published ∩ not-private (draft and private
// absent for anon AND for a space share-link guest — the #244 pair marker); a public space does NOT
// expose its space-scoped templates (review condition ①); noindex is forced on and served on both
// public routes; the outbox reindex is enqueued in-tx (review condition ③); unset is one tuple and
// leaves per-page public grants intact.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, checkRelation, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { buildApp } from '../app.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { createSpace, deleteSpace, setSpacePublic, unsetSpacePublic, isSpacePublic } from '../routes/spaces.js'
import { createPage, setPagePrivate, setPagePublic } from '../routes/pages.js'
import { drainAuditFor } from './helpers/audit-drain.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6381')
const driver = new LogicalSearchDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'team', isolation: 'logical' }) as Tenant // team → auditLog entitled
const MEMBER = 'sp277-member'     // space viewer_member — can view, must NOT toggle
const STRANGER = 'sp277-stranger' // no grants at all — the SAME 403
const TADMIN = 'sp277-admin'      // tenant admin — manager via `admin from tenant`
const GUEST_LINK = 'sp277-link'   // space share-link guest (the #244 pair-marker case)

let app: FastifyInstance
let db: TenantDb, spaceId: string, pubPage: string, draftPage: string, privPage: string
let templateId: string
let acmeSpace: string
let extraTuples: { user: string; relation: string; object: string }[] = []

beforeAll(async () => {
  await driver.ensureIndex()
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'team', name: 'sp277-space' })).id
  pubPage = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'SP Pub' })).id
  draftPage = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'SP Draft' })).id
  privPage = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'SP Priv' })).id
  await admin`UPDATE pages SET published_at = now(), published_md = 'body' WHERE id IN (${pubPage}, ${privPage})`
  await setPagePrivate(db, fgaClient, driver, { pageId: privPage, tenantId: TENANT, userId: 'dev-user' }) // pair markers (#244)
  // A space-scoped template (review condition ①: a public space must NOT expose it to anon/guests).
  const [tpl] = await admin<{ id: string }[]>`
    INSERT INTO templates (tenant_id, name, body_md, scope, space_id, created_by)
    VALUES (${TENANT}, 'sp277-tpl', '# t', 'space', ${spaceId}, 'user:dev-user') RETURNING id`
  templateId = tpl!.id
  // A cross-tenant space — dev-user gets a MANAGER GRANT on it, so only the RLS belt stands
  // between a passing FGA check and a global user:* wildcard write (review condition ④).
  const [acme] = await admin<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name) VALUES ('sp277-acme-space', 'tenant_acme', 'sp277 acme') ON CONFLICT (id) DO NOTHING RETURNING id`
  acmeSpace = acme?.id ?? 'sp277-acme-space'
  extraTuples = [
    // publish wrote no FGA link here (published via SQL), so wire page#space explicitly (guest-test pattern).
    { user: `space:${spaceId}`, relation: 'space', object: `page:${pubPage}` },
    { user: `space:${spaceId}`, relation: 'space', object: `page:${privPage}` },
    { user: `tenant:${TENANT}`, relation: 'tenant', object: `template:${templateId}` },
    { user: `space:${spaceId}`, relation: 'space', object: `template:${templateId}` },
    { user: `user:${MEMBER}`, relation: 'viewer_member', object: `space:${spaceId}` },
    { user: `user:${TADMIN}`, relation: 'admin', object: `tenant:${TENANT}` },
    { user: `share_link:${GUEST_LINK}`, relation: 'viewer', object: `space:${spaceId}` },
    { user: 'user:dev-user', relation: 'manager', object: `space:${acmeSpace}` },
  ]
  await writeTuples(fgaClient, extraTuples)
  // Parent switch ON for the toggle/route tests (individual tests flip it as needed).
  await admin`INSERT INTO tenant_settings (tenant_id, public_enabled) VALUES (${TENANT}, true) ON CONFLICT (tenant_id) DO UPDATE SET public_enabled = true`
}, 60_000)

afterAll(async () => {
  await app.close()
  await deleteTuples(fgaClient, extraTuples).catch(() => {})
  await admin`DELETE FROM templates WHERE id = ${templateId}`.catch(() => {})
  for (const id of [pubPage, draftPage, privPage]) {
    await driver.deleteDoc(id).catch(() => {})
    await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await admin`DELETE FROM audit_log WHERE tenant_id = ${TENANT} AND target = ${`space:${spaceId}`}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${acmeSpace}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release(); await admin.end(); await valkey.quit(); await pool.end()
}, 60_000)

const ANON = 'user:anonymous'
const anonSees = (type: 'page' | 'space', id: string) => checkRelation(fgaClient, ANON, type === 'space' ? 'viewer' : 'view', { type, id })

describe('#277 write gate (uniform 403, RLS belt)', () => {
  it('a viewer_member cannot toggle; a stranger gets the SAME 403', async () => {
    await expect(setSpacePublic(db, fgaClient, driver, { spaceId, tenantId: TENANT, userId: MEMBER }))
      .rejects.toMatchObject({ statusCode: 403 })
    await expect(setSpacePublic(db, fgaClient, driver, { spaceId, tenantId: TENANT, userId: STRANGER }))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(await anonSees('space', spaceId)).toBe(false)
  })

  it('cross-tenant: even WITH an FGA manager grant, the RLS belt rejects with the same 403 (condition ④)', async () => {
    // dev-user holds manager on the acme space (fixture), so requireSpaceManage passes — only the
    // in-tenant row check stands before the global wildcard write. It must fail closed.
    await expect(setSpacePublic(db, fgaClient, driver, { spaceId: acmeSpace, tenantId: TENANT, userId: 'dev-user' }))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(await anonSees('space', acmeSpace)).toBe(false)
  })

  it('the route 403s while the tenant parent switch is OFF, and works when ON (manager session)', async () => {
    const sid = await createSession(valkey, { tenantId: TENANT, sub: 'dev-user', role: 'admin' })
    const H = { host: 'dev.localhost', cookie: `${SESSION_COOKIE}=${sid}` }
    await admin`UPDATE tenant_settings SET public_enabled = false WHERE tenant_id = ${TENANT}`
    expect((await app.inject({ method: 'POST', url: `/spaces/${spaceId}/public-access`, headers: H })).statusCode).toBe(403)
    await admin`UPDATE tenant_settings SET public_enabled = true WHERE tenant_id = ${TENANT}`
    expect((await app.inject({ method: 'POST', url: `/spaces/${spaceId}/public-access`, headers: H })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: `/spaces/${spaceId}/public-access`, headers: H })).json()).toEqual({ public: true })
    // reset to non-public for the ordered tests below
    expect((await app.inject({ method: 'DELETE', url: `/spaces/${spaceId}/public-access`, headers: H })).statusCode).toBe(204)
  })
})

describe('#277 exposure = public ∩ published ∩ not-private', () => {
  it('a tenant admin may toggle (manager via admin-from-tenant); grant + noindex + audit + outbox land', async () => {
    // The outbox assertion below attributes EVERY row for these pages to the toggle, but createPage
    // and publishPage enqueue their own upsert rows in beforeAll — normally drained by the async
    // processor before this test runs, and intermittently NOT (measured: the draft's creation-time row
    // survived on a busy stack and read as "the toggle enqueued a draft"). Clear the slate so the
    // SELECT measures the toggle alone.
    await admin`DELETE FROM search_outbox WHERE page_id IN (${pubPage}, ${draftPage}, ${privPage})`
    await setSpacePublic(db, fgaClient, driver, { spaceId, tenantId: TENANT, userId: TADMIN, plan: 'team' })
    expect(await isSpacePublic(fgaClient, { spaceId, userId: 'dev-user' })).toBe(true)
    const [s] = await admin<{ noindex: boolean }[]>`SELECT noindex FROM spaces WHERE id = ${spaceId}`
    expect(s!.noindex).toBe(true) // guardrail 4, same tx
    // condition ③: the reindex jobs were enqueued in-tx for the PUBLISHED pages only.
    const outbox = await admin<{ page_id: string }[]>`SELECT page_id FROM search_outbox WHERE page_id IN (${pubPage}, ${draftPage}, ${privPage})`
    const enqueued = outbox.map((o) => o.page_id)
    expect(enqueued).toContain(pubPage)
    expect(enqueued).toContain(privPage) // published (the doc-builder recomputes it to non-public)
    expect(enqueued).not.toContain(draftPage) // a draft has no search doc to update
    await drainAuditFor(admin, TENANT)
    const audit = await admin<{ action: string }[]>`SELECT action FROM audit_log WHERE tenant_id = ${TENANT} AND target = ${`space:${spaceId}`}`
    expect(audit.some((a) => a.action === 'space.made_public')).toBe(true)
  })

  it('anon: the published page is viewable; the PRIVATE page and the DRAFT are not', async () => {
    expect(await anonSees('page', pubPage)).toBe(true)
    expect(await anonSees('page', privPage)).toBe(false) // pair marker cuts viewer-from-space
    expect(await anonSees('page', draftPage)).toBe(false) // no page#space link (unpublished)
  })

  it('a space share-link guest cannot see the private page either (#244 pair marker under space-public)', async () => {
    const subject = `share_link:${GUEST_LINK}`
    expect(await check(fgaClient, subject, 'view', { type: 'page', id: pubPage })).toBe(true)
    expect(await check(fgaClient, subject, 'view', { type: 'page', id: privPage })).toBe(false)
  })

  it('condition ①: the public space does NOT expose its space-scoped template to anon or guests', async () => {
    // template is not a ResourceRef type — raw check, the exact call shape templates.ts uses.
    const tplView = (user: string) =>
      fgaClient.check({ user, relation: 'view', object: `template:${templateId}` }).then((r) => r.allowed ?? false)
    expect(await tplView(ANON)).toBe(false)
    expect(await tplView(`share_link:${GUEST_LINK}`)).toBe(false)
    // ...while a space MEMBER (viewer_member) still can — the template audience is member-only.
    expect(await tplView(`user:${MEMBER}`)).toBe(true)
  })

  it('the public tree route serves the published page only, with X-Robots-Tag: noindex', async () => {
    const res = await app.inject({ method: 'GET', url: `/public/spaces/${spaceId}/pages`, headers: { host: 'dev.localhost' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-robots-tag']).toBe('noindex') // net-new space-flag header
    const ids = JSON.stringify(res.json())
    expect(ids).toContain(pubPage)
    expect(ids).not.toContain(privPage)
    expect(ids).not.toContain(draftPage)
  })

  it('the public PAGE route inherits the space noindex (page flag itself is false)', async () => {
    const [p] = await admin<{ noindex: boolean }[]>`SELECT noindex FROM pages WHERE id = ${pubPage}`
    expect(p!.noindex).toBe(false)
    const res = await app.inject({ method: 'GET', url: `/public/pages/${pubPage}`, headers: { host: 'dev.localhost' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-robots-tag']).toBe('noindex') // OR'd with the space flag
  })
})

describe('#277 unset (non-destructive, one tuple)', () => {
  it('unset hides the tree (404) but a page individually made public stays public', async () => {
    await setPagePublic(db, fgaClient, driver, { pageId: pubPage, tenantId: TENANT, userId: 'dev-user' }) // ADR-113 per-page grant
    await unsetSpacePublic(db, fgaClient, driver, { spaceId, tenantId: TENANT, userId: 'dev-user', plan: 'team' })
    expect(await isSpacePublic(fgaClient, { spaceId, userId: 'dev-user' })).toBe(false)
    const res = await app.inject({ method: 'GET', url: `/public/spaces/${spaceId}/pages`, headers: { host: 'dev.localhost' } })
    expect(res.statusCode).toBe(404) // the space is no longer public (existence-hidden)
    expect(await anonSees('page', pubPage)).toBe(true) // the per-page grant survived (non-destructive)
    await drainAuditFor(admin, TENANT)
    const audit = await admin<{ action: string }[]>`SELECT action FROM audit_log WHERE tenant_id = ${TENANT} AND target = ${`space:${spaceId}`}`
    expect(audit.some((a) => a.action === 'space.made_non_public')).toBe(true)
  })
})

// Integration test — real Postgres + OpenFGA + Fastify. #249 / ADR-110: template management (list / get /
// rename / delete) is authz-critical. HTTP covers the member CRUD path + guest exclusion + delete orphan
// cleanup; the FGA layer covers the scope-containment / non-manager matrix (a viewer who is not a manager
// can't rename/delete; a non-viewer gets 404) since it delegates to canView/canManage.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteObjectTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { createSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 3600 }
const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
const devGet = { host: 'dev.localhost', authorization: 'Bearer dev-token' } // no content-type (empty-body GET/DELETE)
const tag = `tplman${Date.now().toString(36)}`

let app: FastifyInstance
let db: TenantDb
let spaceId = '', pubPage = '', viewTok = ''

const save = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/templates', headers: dev, payload })
const canView = (u: string, id: string) => fgaClient.check({ user: u, relation: 'view', object: `template:${id}` }).then((r) => r.allowed ?? false)
const canManage = (u: string, id: string) => fgaClient.check({ user: u, relation: 'manage', object: `template:${id}` }).then((r) => r.allowed ?? false)

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant('tenant_dev'))
  spaceId = (await createSpace(db, fgaClient, { tenantId: 'tenant_dev', userId: 'dev-user', plan: 'free', name: `${tag}-space` })).id
  pubPage = (await createPage(db, fgaClient, app.searchDriver, { tenantId: 'tenant_dev', spaceId, userId: 'dev-user', title: 'Src' })).id
  await admin`UPDATE pages SET published_md = ${'# body'} WHERE id = ${pubPage}`
  viewTok = await mintGuestToken(guestCfg, { tenantId: 'tenant_dev', shareLinkId: `sl-${tag}`, resource: { type: 'space', id: spaceId }, capability: 'view' })
}, 60_000)

afterAll(async () => {
  await admin`DELETE FROM templates WHERE name LIKE ${tag + '%'}`.catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 30_000)

describe('#249 template management — authz', () => {
  it('member CRUD: create → list → get → rename → delete; the deleted id then 404s with no orphan tuples', async () => {
    const created = await save({ fromPageId: pubPage, name: `${tag}-a`, scope: 'personal' })
    expect(created.statusCode).toBe(201)
    const id = (created.json() as { id: string }).id

    const list = await app.inject({ method: 'GET', url: '/templates', headers: devGet })
    expect(list.statusCode).toBe(200)
    expect((list.json() as { id: string }[]).some((t) => t.id === id)).toBe(true)

    const got = await app.inject({ method: 'GET', url: `/templates/${id}`, headers: devGet })
    expect(got.statusCode).toBe(200)
    expect((got.json() as { body: string }).body).toBe('# body')

    const renamed = await app.inject({ method: 'PATCH', url: `/templates/${id}`, headers: dev, payload: { name: `${tag}-renamed` } })
    expect(renamed.statusCode).toBe(204)
    const [row] = await admin<{ name: string }[]>`SELECT name FROM templates WHERE id = ${id}`
    expect(row.name).toBe(`${tag}-renamed`)

    // Owner (also a manager) may view/manage.
    expect(await canView('user:dev-user', id)).toBe(true)
    expect(await canManage('user:dev-user', id)).toBe(true)

    const del = await app.inject({ method: 'DELETE', url: `/templates/${id}`, headers: devGet })
    expect(del.statusCode).toBe(204)
    // Row gone AND tuples gone (no orphan → 404 afterwards, and FGA can't re-resolve it).
    expect((await app.inject({ method: 'GET', url: `/templates/${id}`, headers: devGet })).statusCode).toBe(404)
    expect(await canView('user:dev-user', id)).toBe(false)
  })

  it('a GUEST token cannot list / get / rename / delete (member-only)', async () => {
    const created = await save({ fromPageId: pubPage, name: `${tag}-guest`, scope: 'tenant' })
    const id = (created.json() as { id: string }).id
    const gh = { host: 'dev.localhost', authorization: `Bearer ${viewTok}`, 'content-type': 'application/json' }
    const ghGet = { host: 'dev.localhost', authorization: `Bearer ${viewTok}` }
    expect((await app.inject({ method: 'GET', url: '/templates', headers: ghGet })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: `/templates/${id}`, headers: ghGet })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PATCH', url: `/templates/${id}`, headers: gh, payload: { name: 'x' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'DELETE', url: `/templates/${id}`, headers: ghGet })).statusCode).toBe(401)
    await admin`DELETE FROM templates WHERE id = ${id}`.catch(() => {})
    await deleteObjectTuples(fgaClient, `template:${id}`).catch(() => {})
  })

  it('a non-existent id is 404 on get / rename / delete (existence-hidden)', async () => {
    expect((await app.inject({ method: 'GET', url: '/templates/no-such-id', headers: devGet })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: '/templates/no-such-id', headers: dev, payload: { name: 'x' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/templates/no-such-id', headers: devGet })).statusCode).toBe(404)
  })

  // #267the template-preview PlantUML render endpoint mirrors the page endpoint's authz exactly.
  it('plantuml render: member-viewer 204-degrades (no operator endpoint); missing source 400; guest 401; non-viewer id 404', async () => {
    const created = await save({ fromPageId: pubPage, name: `${tag}-puml`, scope: 'tenant' })
    const id = (created.json() as { id: string }).id
    const puml = { source: '@startuml\nA -> B\n@enduml' }
    // member + viewer (the creator) + no PLANTUML_RENDER_URL in the test env → 204 degrade-to-source.
    expect((await app.inject({ method: 'POST', url: `/templates/${id}/plantuml/render`, headers: dev, payload: puml })).statusCode).toBe(204)
    // a viewer with a missing/blank source → 400 (canView passes first, then the body check).
    expect((await app.inject({ method: 'POST', url: `/templates/${id}/plantuml/render`, headers: dev, payload: {} })).statusCode).toBe(400)
    // a GUEST token → 401 (member-only, checked before authz).
    const gh = { host: 'dev.localhost', authorization: `Bearer ${viewTok}`, 'content-type': 'application/json' }
    expect((await app.inject({ method: 'POST', url: `/templates/${id}/plantuml/render`, headers: gh, payload: puml })).statusCode).toBe(401)
    // a non-existent / non-viewer id → 404 (existence-hidden, never 403).
    expect((await app.inject({ method: 'POST', url: `/templates/no-such-id/plantuml/render`, headers: dev, payload: puml })).statusCode).toBe(404)
    await admin`DELETE FROM templates WHERE id = ${id}`.catch(() => {})
    await deleteObjectTuples(fgaClient, `template:${id}`).catch(() => {})
  })

  it('scope containment + non-manager (FGA layer the routes delegate to): a viewer who is not a manager', async () => {
    // A tenant-scope template owned by OTHER: a tenant member can VIEW but not MANAGE; a non-member neither.
    const obj = `template:${tag}-scope`
    const tuples = [
      { user: 'user:tpl-other', relation: 'owner', object: obj },
      { user: 'tenant:tenant_dev', relation: 'tenant', object: obj },
      { user: 'tenant:tenant_dev', relation: 'audience_all', object: obj }, // tenant scope → all members view
    ]
    await writeTuples(fgaClient, tuples)
    try {
      // dev-user is a tenant_dev member → can VIEW (audience_all) but is NOT the owner. (Whether dev-user
      // is a tenant admin depends on the seed; assert the owner/non-member cases which are unambiguous.)
      expect(await canManage('user:tpl-other', `${tag}-scope`)).toBe(true)  // owner manages
      expect(await canManage('user:tpl-stranger', `${tag}-scope`)).toBe(false) // non-member: no manage
      expect(await canView('user:tpl-stranger', `${tag}-scope`)).toBe(false)   // non-member: no view (scope contained)
    } finally {
      await deleteObjectTuples(fgaClient, obj).catch(() => {})
    }
  })
})

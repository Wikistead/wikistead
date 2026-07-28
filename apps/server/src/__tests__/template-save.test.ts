// Integration test — real Postgres + OpenFGA + Fastify, no mocks. #248 / ADR-110: the template SAVE path
// is security-critical. Boundaries: only a member (not a guest) can save; the saver must be able to VIEW
// the source page (else 404, existence-hidden, no row/tuple); cross-tenant sources are 404; an unpublished
// page is 400. A shared-scope (tenant) save from a viewable page is allowed (the "intentional re-publish"
// warning is UI-side).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, deleteObjectTuples } from '@wikistead/authz'
import { memberTuples, ensureMembers } from './helpers/membership.js'
import { mintGuestToken } from '@wikistead/auth'
import { createSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { saveTemplate } from '../routes/templates.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 3600 }
const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
const tag = `tplsave${Date.now().toString(36)}`

let app: FastifyInstance
let db: TenantDb
let spaceId = '', pubPage = '', unpubPage = '', acmePage = '', viewTok = ''

const countRows = async (name: string) =>
  Number((await admin<[{ n: string }]>`SELECT count(*)::text AS n FROM templates WHERE name = ${name}`)[0].n)
const save = (payload: Record<string, unknown>, headers: Record<string, string> = dev) =>
  app.inject({ method: 'POST', url: '/templates', headers, payload })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  // #471 / ADR-176: space creation is granted to this tenant's MEMBERS (it used to be a `user:*`
  // wildcard, which matched anyone the server authenticated at all), so a fixture acting as
  // someone must make them a member — which is what these subs always meant to be.
  await ensureMembers('tenant_dev', ['dev-user'])
  await ensureMembers('tenant_acme', ['acme-user']) // the acme fixture below creates a space AS them
  db = await acquireTenantDb(asTenant('tenant_dev'))
  spaceId = (await createSpace(db, fgaClient, { tenantId: 'tenant_dev', userId: 'dev-user', plan: 'free', name: `${tag}-space` })).id
  pubPage = (await createPage(db, fgaClient, app.searchDriver, { tenantId: 'tenant_dev', spaceId, userId: 'dev-user', title: 'Pub' })).id
  unpubPage = (await createPage(db, fgaClient, app.searchDriver, { tenantId: 'tenant_dev', spaceId, userId: 'dev-user', title: 'Unpub' })).id
  await admin`UPDATE pages SET published_md = ${'# Published body'} WHERE id = ${pubPage}`

  // A cross-tenant source: a published page under tenant_acme that dev-user cannot view.
  const acmeDb = await acquireTenantDb(asTenant('tenant_acme'))
  try {
    const acmeSpace = (await createSpace(acmeDb, fgaClient, { tenantId: 'tenant_acme', userId: 'acme-user', plan: 'free', name: `${tag}-acme` })).id
    acmePage = (await createPage(acmeDb, fgaClient, app.searchDriver, { tenantId: 'tenant_acme', spaceId: acmeSpace, userId: 'acme-user', title: 'Acme' })).id
    await admin`UPDATE pages SET published_md = ${'# Acme body'} WHERE id = ${acmePage}`
  } finally {
    await acmeDb.release()
  }

  viewTok = await mintGuestToken(guestCfg, { tenantId: 'tenant_dev', shareLinkId: `sl-${tag}`, resource: { type: 'space', id: spaceId }, capability: 'view' })
}, 60_000)

afterAll(async () => {
  await admin`DELETE FROM templates WHERE name LIKE ${tag + '%'}`.catch(() => {})
  await db.release() // release the pooled tenant conn BEFORE pool.end(), else it waits forever
  await app.close()
  await admin.end()
  await pool.end()
}, 30_000)

describe('#248 template save — authz', () => {
  it('a member saves a personal template from a published page (201, row + owner can view)', async () => {
    const name = `${tag}-personal`
    const res = await save({ fromPageId: pubPage, name, scope: 'personal' })
    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    expect(id).toBeTruthy()
    expect(await countRows(name)).toBe(1)
    expect((await fgaClient.check({ user: 'user:dev-user', relation: 'view', object: `template:${id}` })).allowed).toBe(true)
  })

  it('a tenant-scope save from a viewable page is allowed (intentional re-publish; 201)', async () => {
    const name = `${tag}-tenant`
    const res = await save({ fromPageId: pubPage, name, scope: 'tenant' })
    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    // the audience_all tuple was written → the tenant audience resolves (verified in template-fga.test).
    const [row] = await admin<{ scope: string }[]>`SELECT scope FROM templates WHERE id = ${id}`
    expect(row.scope).toBe('tenant')
  })

  it('a GUEST token cannot save (member-only route) and no row is created', async () => {
    const name = `${tag}-guest`
    const res = await save({ fromPageId: pubPage, name, scope: 'personal' },
      { host: 'dev.localhost', authorization: `Bearer ${viewTok}`, 'content-type': 'application/json' })
    expect(res.statusCode).toBe(401)
    expect(await countRows(name)).toBe(0)
  })

  it('a non-viewable / non-existent source is 404 and creates no row', async () => {
    const name = `${tag}-missing`
    const res = await save({ fromPageId: 'no-such-page-xyz', name, scope: 'personal' })
    expect(res.statusCode).toBe(404)
    expect(await countRows(name)).toBe(0)
  })

  it('a CROSS-TENANT source is 404 and creates no row (existence-hidden)', async () => {
    const name = `${tag}-xtenant`
    const res = await save({ fromPageId: acmePage, name, scope: 'personal' })
    expect(res.statusCode).toBe(404)
    expect(await countRows(name)).toBe(0)
  })

  it('an unpublished page cannot be templated (400, no row)', async () => {
    const name = `${tag}-unpub`
    const res = await save({ fromPageId: unpubPage, name, scope: 'personal' })
    expect(res.statusCode).toBe(400)
    expect(await countRows(name)).toBe(0)
  })

  // #529 follow-up (design review): the space-scope save gate used to ask for space `view`
  // (= `viewer`), while `template#view` reads `viewer_member from space` (#258, templates are
  // member-only). Anyone the space is merely VISIBLE to could therefore write a template into a set they
  // could not read — and after #529 put `commenter` on `viewer`, that included a bare space commenter,
  // which is precisely what the ruling meant to stop. Read and write now name the same relation.
  describe('#529: space-scope save asks for the same set that can READ the templates', () => {
    const spaceCommenter = `${tag}-commenter`
    const spaceMember = `${tag}-member`
    // Built INSIDE beforeAll: `spaceId` and `pubPage` are assigned by the outer beforeAll, and a describe
    // body runs at collection time — an array built there would embed `space:` with an empty id, every
    // write would fail, and the "commenter is refused" test would pass because the commenter had no
    // grant at all. (Measured: viewer=false for a principal the fixture claimed to have granted.)
    let tuples: { user: string; relation: string; object: string }[] = []
    beforeAll(async () => {
      tuples = [
        { user: `user:${spaceCommenter}`, relation: 'commenter', object: `space:${spaceId}` },
        { user: `user:${spaceMember}`, relation: 'viewer', object: `space:${spaceId}` },
        { user: `user:${spaceMember}`, relation: 'viewer_member', object: `space:${spaceId}` },
        // Publish shape: a DRAFT is creator-only, so neither principal could view the source page and
        // both would 404 at the FIRST gate — the test would then pass for the wrong reason.
        { user: `space:${spaceId}`, relation: 'space', object: `page:${pubPage}` },
        { user: 'user:*', relation: 'published', object: `page:${pubPage}` },
        { user: 'share_link:*', relation: 'published', object: `page:${pubPage}` },
      ]
      await ensureMembers('tenant_dev', [spaceCommenter, spaceMember])
      for (const t of tuples) await writeTuples(fgaClient, [t]).catch(() => {})
    }, 30_000)
    afterAll(async () => { await deleteTuples(fgaClient, tuples).catch(() => {}) }, 30_000)

    // The route's dev bearer always authenticates `dev-user`, so these call the function with the
    // subject directly — the same way the moderator pin (#330) exercises this path.
    it('a bare space COMMENTER cannot save a space-scope template (404, no row)', async () => {
      const name = `${tag}-commenter-save`
      await expect(saveTemplate(db, fgaClient, {
        tenantId: 'tenant_dev', userId: spaceCommenter, fromPageId: pubPage, name, scope: 'space', spaceId,
      })).rejects.toMatchObject({ statusCode: 404 })
      expect(await countRows(name)).toBe(0)
    })

    it('a space MEMBER (viewer_member) still saves one', async () => {
      const name = `${tag}-member-save`
      const saved = await saveTemplate(db, fgaClient, {
        tenantId: 'tenant_dev', userId: spaceMember, fromPageId: pubPage, name, scope: 'space', spaceId,
      })
      expect(saved.id).toBeTruthy()
      expect(await countRows(name)).toBe(1)
      await admin`DELETE FROM templates WHERE id = ${saved.id}`.catch(() => {})
      await deleteObjectTuples(fgaClient, `template:${saved.id}`).catch(() => {})
    })
  })
})

// #420 / ADR-164 increment 2: the custom-role STORE (definitions CRUD). Anti-tests:
//  (1) entitlement — with customRoles OFF, define/edit/delete are refused with the entitlement
//      denial and no data; the LIST stays available on every plan (uniform picker, built-ins).
//  (2) tenant-admin gate — a non-admin gets 403 everywhere (list included).
//  (3) definition validation — reserved/built-in names, unknown capabilities, `manage` (the
//      built-in superset, not a bundleable atom), empty sets, duplicate names.
//  (4) cross-tenant RLS — a role defined in dev is invisible through another tenant's handle.
//  (5) delete with live assignments is refused (orphaned-tuple protection, 409).
// Real Postgres + the app via inject (dev bearer = tenant admin dev-user).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { registerEntitlementsResolver, resetEntitlementsResolver, UNLIMITED } from '@wikistead/entitlements'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import { buildApp } from '../app.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { memberTuples, ensureMembers } from './helpers/membership.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

let app: FastifyInstance
let tenant: Tenant

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  app = await buildApp()
  await app.ready()
}, 60_000)

afterAll(async () => {
  resetEntitlementsResolver()
  // Scoped to the roles THIS file created. The wholesale delete that used to be here also removed the
  // assignments of every other suite file sharing `tenant_dev` — the shape of defect that made the
  // audit assertions flake (#482). It was redundant besides: role_assignments.role_id is
  // ON DELETE CASCADE, so the prefixed `roles` delete on the next line already takes them.
  await admin`DELETE FROM role_assignments WHERE tenant_id = ${tenant.id} AND role_id IN (SELECT id FROM roles WHERE tenant_id = ${tenant.id} AND name LIKE 'crs420%')`
  await admin`DELETE FROM roles WHERE tenant_id = ${tenant.id} AND name LIKE 'crs420%'`
  await app?.close()
  await pool.end()
  await admin.end()
}, 60_000)

describe('custom-role store (#420 increment 2)', () => {
  it('anti-test 1: customRoles OFF → define/edit/delete refused with the entitlement denial; LIST still serves built-ins', async () => {
    registerEntitlementsResolver(() => ({ ...UNLIMITED, customRoles: false }))
    try {
      const post = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name: 'crs420-nope', capabilities: ['delete'] } })
      expect(post.statusCode).toBe(403)
      expect(post.body).toContain('customRoles_not_entitled')
      const put = await app.inject({ method: 'PUT', url: '/admin/roles/some-id', headers: H, payload: { name: 'crs420-x', capabilities: ['view'] } })
      expect(put.statusCode).toBe(403)
      const del = await app.inject({ method: 'DELETE', url: '/admin/roles/some-id', headers: H })
      expect(del.statusCode).toBe(403)
      // The list keeps working (built-ins are free on every plan).
      const list = await app.inject({ method: 'GET', url: '/admin/roles', headers: H })
      expect(list.statusCode).toBe(200)
      expect((list.json() as { builtIn: { name: string }[] }).builtIn.map((r) => r.name)).toContain('manager')
    } finally {
      resetEntitlementsResolver()
    }
  })

  it('anti-test 2: a non-admin is 403 on every route (list included)', async () => {
    // dev-token on the ACME host authenticates dev-user, who is not acme's admin. #471: they must
    // be an acme MEMBER for this to be the non-admin case — a non-member is refused one layer
    // earlier, which is a different test (tenant-membership-471).
    await ensureMembers('tenant_acme', ['dev-user'])
    const AH = { host: 'acme.localhost', authorization: 'Bearer dev-token' }
    for (const [method, url] of [['GET', '/admin/roles'], ['POST', '/admin/roles'], ['DELETE', '/admin/roles/x']] as const) {
      const r = await app.inject({ method, url, headers: AH, ...(method === 'POST' ? { payload: { name: 'n', capabilities: ['view'] } } : {}) })
      expect(r.statusCode, `${method} ${url}`).toBe(403)
      expect(r.body, `${method} ${url}`).not.toContain('builtIn')
    }
    await deleteTuples(fgaClient, memberTuples('tenant_acme', ['dev-user'])).catch(() => {})
  })

  it('anti-test 3: definition validation — reserved names, unknown caps, manage, empty, duplicates', async () => {
    const bad = async (payload: unknown, contains: string) => {
      const r = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: payload as Record<string, unknown> })
      expect(r.statusCode, contains).toBe(400)
      expect(r.body, contains).toContain(contains)
    }
    await bad({ name: 'manager', capabilities: ['view'] }, 'built-in')
    await bad({ name: 'Viewer', capabilities: ['view'] }, 'built-in') // case-insensitive reservation
    await bad({ name: 'crs420-a', capabilities: ['teleport'] }, 'unknown capability')
    await bad({ name: 'crs420-a', capabilities: ['manage'] }, 'unknown capability') // superset is not an atom
    await bad({ name: 'crs420-a', capabilities: [] }, 'capabilities')
    await bad({ name: '', capabilities: ['view'] }, 'name')

    const ok = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name: 'crs420-recycler', capabilities: ['delete', 'view'] } })
    expect(ok.statusCode).toBe(201)
    const dup = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name: 'crs420-recycler', capabilities: ['view'] } })
    expect(dup.statusCode).toBe(409)

    const list = (await app.inject({ method: 'GET', url: '/admin/roles', headers: H })).json() as { custom: { id: string; name: string; capabilities: string[] }[] }
    const mine = list.custom.find((r) => r.name === 'crs420-recycler')!
    expect(mine.capabilities.sort()).toEqual(['delete', 'view'])

    // rename + capability edit round-trips
    const put = await app.inject({ method: 'PUT', url: `/admin/roles/${mine.id}`, headers: H, payload: { name: 'crs420-recycler2', capabilities: ['delete'] } })
    expect(put.statusCode).toBe(200)
    const del = await app.inject({ method: 'DELETE', url: `/admin/roles/${mine.id}`, headers: H })
    expect(del.statusCode).toBe(204)
  })

  it('anti-test 4: cross-tenant RLS — a dev role is invisible through another tenant handle', async () => {
    const create = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name: 'crs420-rls', capabilities: ['comment'] } })
    expect(create.statusCode).toBe(201)
    const acme = (await new TenantRegistry(pool).findBySlug('acme'))!
    const acmeDb = await acquireTenantDb(acme)
    try {
      const rows = await acmeDb.sql<{ name: string }[]>`SELECT name FROM roles`
      expect(rows.some((r) => r.name === 'crs420-rls'), 'dev role must not leak into the acme handle').toBe(false)
    } finally {
      await acmeDb.release()
    }
  })

  it('anti-test 5: deleting a role with LIVE assignments is refused (409 — no orphaned expansions)', async () => {
    const create = await app.inject({ method: 'POST', url: '/admin/roles', headers: H, payload: { name: 'crs420-live', capabilities: ['share'] } })
    const { id } = create.json() as { id: string }
    await admin`INSERT INTO role_assignments (id, tenant_id, role_id, resource_type, resource_id, principal)
                VALUES ('crs420-asg', ${tenant.id}, ${id}, 'page', 'crs420-page', 'user:crs420-bob')`
    try {
      const del = await app.inject({ method: 'DELETE', url: `/admin/roles/${id}`, headers: H })
      expect(del.statusCode).toBe(409)
      expect(del.body).toContain('unassign')
    } finally {
      await admin`DELETE FROM role_assignments WHERE id = 'crs420-asg'`
      await app.inject({ method: 'DELETE', url: `/admin/roles/${id}`, headers: H })
    }
  })
})

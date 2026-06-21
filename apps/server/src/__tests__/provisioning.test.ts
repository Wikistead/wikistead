// Integration tests — real Postgres + real OpenFGA, no mocks.
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import { pool } from '../db/pool.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { provisionTenant, bootstrapFirstAdmin, isValidSlug } from '../auth/provisioning.js'
import type { Tenant } from '@wikistead/types'

// Raw FGA relation check (tenant#admin/#member are not page/space Capabilities).
const hasRel = async (user: string, relation: string, object: string) =>
  Boolean((await fgaClient.check({ user, relation, object })).allowed)

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const created: string[] = [] // tenant ids to clean up

afterAll(async () => {
  for (const id of created) {
    await admin`DELETE FROM members WHERE tenant_id = ${id}`.catch(() => {})
    await admin`DELETE FROM tenants WHERE id = ${id}`.catch(() => {})
  }
  await admin.end()
  await pool.end()
})

// fga proxy that throws on writes adding a given relation (to test rollback)
function fgaFailingWrite(): OpenFgaClient {
  return new Proxy(fgaClient, {
    get(t, p, r) {
      if (p === 'write') return async () => { throw new Error('injected FGA write failure') }
      const v = Reflect.get(t, p, r)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
    },
  }) as OpenFgaClient
}

describe('isValidSlug', () => {
  it('accepts valid DNS labels and rejects reserved / malformed ones', () => {
    expect(isValidSlug('acme')).toBe(true)
    expect(isValidSlug('my-team-1')).toBe(true)
    for (const bad of ['api', 'auth', 'admin', 'www', '-x', 'x-', 'UPPER', 'a_b', 'a.b', '', 'x'.repeat(64)]) {
      expect(isValidSlug(bad)).toBe(false)
    }
  })
})

describe('provisionTenant (Cloud signup)', () => {
  it('creates a tenant with the creator as the sole admin (DB + FGA)', async () => {
    const slug = `p2prov-${Date.now().toString(36)}`
    const { tenantId } = await provisionTenant(fgaClient, { slug, admin: { sub: 'creator-1', email: 'c@x.test' } })
    created.push(tenantId)

    const [t] = await admin`SELECT slug, plan FROM tenants WHERE id = ${tenantId}`
    expect(t).toMatchObject({ slug, plan: 'free' })
    const ms = await admin`SELECT sub, role FROM members WHERE tenant_id = ${tenantId}`
    expect(ms).toEqual([{ sub: 'creator-1', role: 'admin' }]) // exactly one, admin
    expect(await hasRel('user:creator-1', 'admin', `tenant:${tenantId}`)).toBe(true)
    await deleteTuples(fgaClient, [
      { user: 'user:creator-1', relation: 'admin', object: `tenant:${tenantId}` },
      { user: 'user:creator-1', relation: 'member', object: `tenant:${tenantId}` },
    ])
  })

  it('rejects a duplicate slug', async () => {
    const slug = `p2dup-${Date.now().toString(36)}`
    const { tenantId } = await provisionTenant(fgaClient, { slug, admin: { sub: 'dup-a' } })
    created.push(tenantId)
    await expect(provisionTenant(fgaClient, { slug, admin: { sub: 'dup-b' } })).rejects.toMatchObject({ statusCode: 409 })
    await deleteTuples(fgaClient, [
      { user: 'user:dup-a', relation: 'admin', object: `tenant:${tenantId}` },
      { user: 'user:dup-a', relation: 'member', object: `tenant:${tenantId}` },
    ])
  })

  it('rejects an invalid slug before touching the DB', async () => {
    await expect(provisionTenant(fgaClient, { slug: 'api', admin: { sub: 'x' } })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rolls back fully when the FGA grant fails (no admin-less tenant)', async () => {
    const slug = `p2rb-${Date.now().toString(36)}`
    await expect(provisionTenant(fgaFailingWrite(), { slug, admin: { sub: 'rb-1' } })).rejects.toThrow()
    const rows = await admin`SELECT 1 FROM tenants WHERE slug = ${slug}`
    expect(rows.length).toBe(0) // tenant row rolled back
  })
})

describe('bootstrapFirstAdmin (CE first-login)', () => {
  async function freshTenant(slug: string): Promise<Tenant> {
    const [t] = await admin<{ id: string }[]>`INSERT INTO tenants (slug, plan) VALUES (${slug}, 'free') RETURNING id`
    created.push(t.id)
    return { id: t.id, slug, isolation: 'logical', plan: 'free' } as Tenant
  }
  const cleanupTuples = (id: string, sub: string) =>
    deleteTuples(fgaClient, [
      { user: `user:${sub}`, relation: 'admin', object: `tenant:${id}` },
      { user: `user:${sub}`, relation: 'member', object: `tenant:${id}` },
    ])

  it('the first login into a member-less tenant becomes admin; a later login does not', async () => {
    const t = await freshTenant(`p2boot-${Date.now().toString(36)}`)
    const db = await acquireTenantDb(t)
    try {
      expect(await bootstrapFirstAdmin({ db, fga: fgaClient }, t, { sub: 'first-1' })).toBe(true)
      expect(await hasRel('user:first-1', 'admin', `tenant:${t.id}`)).toBe(true)
      // second login: tenant now has a member → NOT auto-admitted (needs invite)
      expect(await bootstrapFirstAdmin({ db, fga: fgaClient }, t, { sub: 'second-2' })).toBe(false)
      expect(await hasRel('user:second-2', 'member', `tenant:${t.id}`)).toBe(false)
    } finally {
      await cleanupTuples(t.id, 'first-1')
      await db.release()
    }
  })

  it('concurrent first-logins resolve to EXACTLY ONE admin (atomic guard)', async () => {
    const t = await freshTenant(`p2race-${Date.now().toString(36)}`)
    const db1 = await acquireTenantDb(t)
    const db2 = await acquireTenantDb(t)
    try {
      const [a, b] = await Promise.all([
        bootstrapFirstAdmin({ db: db1, fga: fgaClient }, t, { sub: 'race-a' }),
        bootstrapFirstAdmin({ db: db2, fga: fgaClient }, t, { sub: 'race-b' }),
      ])
      expect([a, b].filter(Boolean).length).toBe(1) // exactly one won
      const ms = await admin`SELECT sub FROM members WHERE tenant_id = ${t.id}`
      expect(ms.length).toBe(1)
    } finally {
      // only the winner has tuples; tolerate the loser's missing-tuple delete
      await cleanupTuples(t.id, 'race-a').catch(() => {})
      await cleanupTuples(t.id, 'race-b').catch(() => {})
      await db1.release()
      await db2.release()
    }
  })
})

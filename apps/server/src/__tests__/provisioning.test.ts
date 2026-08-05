// Integration tests — real Postgres + real OpenFGA, no mocks.
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import { pool } from '../db/pool.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { provisionTenant, isValidSlug } from '../auth/provisioning.js'
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

// RE-AIMED (#616 / ADR-212 slice 2). The `bootstrapFirstAdmin` block that stood here measured the
// first-login route to admin: that somebody became one, and that concurrent logins resolved to exactly
// ONE. The mechanism is retired (user ruling 2026-08-05) — but the SECOND property is not about it, it
// is about tenant creation racing, and it now belongs to the entrance that survives.
//
// The first property is not re-aimed here: "the person the operator invited becomes an administrator"
// is measured end to end by `local-admin-cli-616`, against the store rather than the members row.
describe('#616: creating a tenant still resolves a race to exactly one admin', () => {
  it('two concurrent provisions of the same slug: one wins, one is refused, and no half-tenant is left', async () => {
    // `provisionTenant` guards on UNIQUE(slug) inside its transaction, so a lost race must roll back
    // the tenant AND the member row it had begun to write — a slug that 409s while leaving a member
    // behind is the shape the retired advisory lock existed to prevent, in the surviving entrance.
    const slug = `p2race-${Date.now().toString(36)}`
    const results = await Promise.allSettled([
      provisionTenant(fgaClient, { slug, admin: { sub: 'race-a-616' } }),
      provisionTenant(fgaClient, { slug, admin: { sub: 'race-b-616' } }),
    ])
    const won = results.filter((r) => r.status === 'fulfilled')
    expect(won.length, 'exactly one provision wins the slug').toBe(1)
    const winner = (won[0] as PromiseFulfilledResult<{ tenantId: string }>).value.tenantId
    created.push(winner)

    const rows = await admin`SELECT id FROM tenants WHERE slug = ${slug}`
    expect(rows.length, 'and there is ONE tenant, not two').toBe(1)
    const members = await admin<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${winner}`
    expect(members.length, 'seated exactly one admin — the loser left nothing behind').toBe(1)
    await deleteTuples(fgaClient, [
      { user: `user:${members[0]!.sub}`, relation: 'admin', object: `tenant:${winner}` },
      { user: `user:${members[0]!.sub}`, relation: 'member', object: `tenant:${winner}` },
      { user: `tenant:${winner}#member`, relation: 'space_creator', object: `tenant:${winner}` },
    ]).catch(() => {})
  })
})

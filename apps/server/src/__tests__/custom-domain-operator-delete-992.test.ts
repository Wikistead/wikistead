// Integration test (real Postgres + real app) — #992 / ADR-262 §3.3: a row an OPERATOR registered
// with `local-admin --domain` is not the tenant's to release.
//
// WHY THIS IS A BUG AND NOT A POLISH ITEM: ADR-258 exists because a host whose first label is
// reserved (`docs.example.com`) has no web route to prove ownership through. So the shell-registered
// row IS the deployment's entrance, and deleting it takes away something the tenant cannot re-create
// — only somebody holding the administrative DSN can put it back. Until #992 the delete button beside
// it was an ordinary one, and `listCustomDomains` did not even return the field that tells the two
// kinds of row apart.
//
// ⚠️ REFUSED, not confirmed — the ruling of 2026-08-27 is explicit that a dialog in front of an
// irreversible act asks somebody to decide who has no way to know it is irreversible.
//
// Throwaway tenants only: the shared fixtures are the class ADR-258's cross-workspace refusal reasons
// about, so a leftover row would let a walk answer for the wrong reason.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { namespaceSchema, provisionNamespaceSchema, promoteTenantToNamespace } from '../db/namespace.js'
import {
  addCustomDomain, verifyCustomDomain, registerCustomDomainByOperator, removeCustomDomain, listCustomDomains,
} from '../routes/custom-domains.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const asTenant = (id: string, plan = 'pro'): Tenant => ({ id, slug: id, plan, isolation: 'logical' }) as Tenant

const madeSlugs: string[] = []

async function dropTenant(slug: string): Promise<void> {
  const [t] = await admin<{ id: string }[]>`SELECT id FROM tenants WHERE slug = ${slug}`
  if (!t) return
  await admin`DELETE FROM custom_domains WHERE tenant_id = ${t.id}`.catch(() => {})
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespaceSchema(t.id)} CASCADE`).catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${t.id}`.catch(() => {})
}

const mkTenant = async (slug: string): Promise<string> => {
  madeSlugs.push(slug)
  const [t] = await admin<{ id: string }[]>`INSERT INTO tenants (slug, plan) VALUES (${slug}, 'pro') RETURNING id`
  return t!.id
}

/** Add a domain through the WEB route and prove it, so the row is genuinely `source='dns'`. */
async function proveThroughTheWebRoute(tenantId: string, domain: string): Promise<void> {
  const { acquireTenantDb } = await import('../db/index.js')
  const tdb = await acquireTenantDb(asTenant(tenantId))
  try {
    await addCustomDomain(tdb, { tenantId, plan: 'pro', domain })
    const [tok] = await admin<{ verification_token: string }[]>`
      SELECT verification_token FROM custom_domains WHERE domain = ${domain}`
    await verifyCustomDomain(tdb, { tenantId, domain }, { resolveTxt: async () => [[tok!.verification_token]] })
  } finally {
    await tdb.release()
  }
}

const withDb = async <T>(tenantId: string, fn: (db: Awaited<ReturnType<typeof import('../db/index.js')['acquireTenantDb']>>) => Promise<T>): Promise<T> => {
  const { acquireTenantDb } = await import('../db/index.js')
  const tdb = await acquireTenantDb(asTenant(tenantId))
  try { return await fn(tdb) } finally { await tdb.release() }
}

const rowsFor = async (tenantId: string): Promise<{ domain: string; source: string }[]> =>
  admin<{ domain: string; source: string }[]>`
    SELECT domain, source FROM custom_domains WHERE tenant_id = ${tenantId} ORDER BY domain`

afterAll(async () => {
  for (const s of madeSlugs) await dropTenant(s)
  await admin.end(); await pool.end()
}, 180_000)

describe('#992 / ADR-262 §3.3: the tenant cannot release what an operator registered', () => {
  // BOTH DIRECTIONS IN ONE TENANT, on purpose: a test that only proves the refusal would stay green
  // if the guard refused everything, which is the failure this fix is one careless predicate away
  // from. The dns row deleting is what says the guard reads provenance rather than just saying no.
  it('refuses the shell row, and still releases the one the tenant proved through the web route', async () => {
    const slug = `cd992a${STAMP}`
    const tenantId = await mkTenant(slug)
    const shellHost = `shell-${STAMP}.example.com`
    const webHost = `web-${STAMP}.example.com`

    await registerCustomDomainByOperator(tenantId, shellHost)
    await proveThroughTheWebRoute(tenantId, webHost)
    expect(await rowsFor(tenantId), 'fixture: one row of each provenance').toEqual([
      { domain: shellHost, source: 'shell' },
      { domain: webHost, source: 'dns' },
    ])

    await withDb(tenantId, async (db) => {
      // ⚠️ The code is asserted, not only the status: `operator_managed` is what tells this refusal
      // apart from the 404 a missing domain gives and the 403 an entitlement gives, and a caller that
      // reads only the status cannot say which happened.
      await expect(removeCustomDomain(db, { tenantId, domain: shellHost }))
        .rejects.toMatchObject({ statusCode: 409, code: 'operator_managed' })
      // The other direction, through the same guard, in the same tenant.
      await expect(removeCustomDomain(db, { tenantId, domain: webHost })).resolves.toBeUndefined()
    })

    expect(await rowsFor(tenantId), 'the operator row survived; the tenant-proved one is gone')
      .toEqual([{ domain: shellHost, source: 'shell' }])
  }, 60_000)

  // The refusal is useless if the screen cannot see the difference before the button is pressed —
  // ADR-262 §3.3 is one decision with two halves, and this is the half a server-only pin would miss.
  it('the list carries provenance, so the screen can tell the two rows apart', async () => {
    const slug = `cd992b${STAMP}`
    const tenantId = await mkTenant(slug)
    const shellHost = `lshell-${STAMP}.example.com`
    const webHost = `lweb-${STAMP}.example.com`

    await registerCustomDomainByOperator(tenantId, shellHost)
    await proveThroughTheWebRoute(tenantId, webHost)

    const page = await withDb(tenantId, (db) => listCustomDomains(db, {}))
    const bySource = Object.fromEntries(page.domains.map((d) => [d.domain, d.source]))
    expect(bySource[shellHost], 'the operator row says so').toBe('shell')
    expect(bySource[webHost], 'the tenant-proved row says so').toBe('dns')
  }, 60_000)

  // ⚠️ ADR-258 §3.3's stated gap, and the reason this fix's 42703 handling goes the OPPOSITE way from
  // `registerCustomDomainByOperator`'s. A tenant promoted to its own schema before migration 131 has
  // no `source` column — and BY CONSTRUCTION holds no shell rows, because the only writer of one
  // refuses exactly that schema. So the absence must not become a bare 42703 in front of a tenant
  // admin releasing an ordinary domain: the delete proceeds, and the list answers `dns`.
  it('a namespace schema with no source column still lists and still releases', async () => {
    const slug = `cd992c${STAMP}`
    const tenantId = await mkTenant(slug)
    const host = `ns-${STAMP}.example.com`

    await proveThroughTheWebRoute(tenantId, host)
    await provisionNamespaceSchema(tenantId, admin)
    await promoteTenantToNamespace({ id: tenantId, slug, plan: 'pro', isolation: 'logical' } as Tenant, admin)
    await admin`UPDATE tenants SET isolation = 'namespace' WHERE id = ${tenantId}`
    // Reproduce the gap itself rather than a stand-in for it: the promoted copy predates migration 131.
    await admin.unsafe(`ALTER TABLE ${namespaceSchema(tenantId)}.custom_domains DROP COLUMN source`)

    const nsTenant = { id: tenantId, slug, plan: 'pro', isolation: 'namespace' } as Tenant
    const { acquireTenantDb } = await import('../db/index.js')
    const tdb = await acquireTenantDb(nsTenant)
    try {
      const page = await listCustomDomains(tdb, {})
      expect(page.domains.map((d) => d.source), 'no column means every row was web-proved').toEqual(['dns'])
      await expect(removeCustomDomain(tdb, { tenantId, domain: host }),
        'the absence of the column is not an error here — there is nothing to protect')
        .resolves.toBeUndefined()
    } finally {
      await tdb.release()
    }
  }, 60_000)

  // A guard that swallows every database failure would pass every test above while hiding a real one:
  // the row would read as "not a shell row" and the delete would go through on a tenant whose
  // provenance could not be established at all.
  //
  // ⚠️ THE STUB HAS TO REJECT, NOT THROW. A first version of this pin made `db.sql` throw
  // synchronously, which escapes before `.catch()` is ever attached — so it stayed green with the
  // `code === '42703'` test deleted, measuring the synchronous throw instead of the catch's
  // selectivity. `postgres` hands back a rejected promise, and so does this.
  it('a failure that is NOT the missing column still propagates', async () => {
    const slug = `cd992d${STAMP}`
    const tenantId = await mkTenant(slug)
    const host = `err-${STAMP}.example.com`
    await proveThroughTheWebRoute(tenantId, host)

    await withDb(tenantId, async (db) => {
      const boom = Object.assign(new Error('connection reset'), { code: '08006' })
      const broken = { ...db, sql: (() => Promise.reject(boom)) as unknown as typeof db.sql }
      await expect(removeCustomDomain(broken as typeof db, { tenantId, domain: host }))
        .rejects.toMatchObject({ code: '08006' })
    })
  }, 60_000)
})

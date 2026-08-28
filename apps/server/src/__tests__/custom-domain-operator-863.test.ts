// Integration test (real Postgres + real app) — #863 / ADR-258: `local-admin --domain` gives a
// deployment served on a reserved-label host (`docs.example.com`) a first-run path, by proving
// possession of the administrative database DSN instead of a DNS-TXT challenge.
//
// Everything runs on THROWAWAY tenants made and dropped here (the shared `acme`/`dev` fixtures are the
// exact class this ADR's cross-workspace refusal has to reason about, so a stray leftover row from a
// prior run would make the walk answer for the wrong reason).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { namespaceSchema, provisionNamespaceSchema, promoteTenantToNamespace } from '../db/namespace.js'
import { addCustomDomain, verifyCustomDomain, registerCustomDomainByOperator, recheckCustomDomains } from '../routes/custom-domains.js'
import { createLocalAdmin } from '../scripts/local-admin.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const asTenant = (id: string, plan = 'business'): Tenant => ({ id, slug: id, plan, isolation: 'logical' }) as Tenant

const madeSlugs: string[] = []
let app: FastifyInstance

/** Drop everything a throwaway tenant leaves behind, in FK order (custom_domains before tenants). */
async function dropTenant(slug: string): Promise<void> {
  const [t] = await admin<{ id: string }[]>`SELECT id FROM tenants WHERE slug = ${slug}`
  if (!t) return
  await admin`DELETE FROM custom_domains WHERE tenant_id = ${t.id}`.catch(() => {})
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespaceSchema(t.id)} CASCADE`).catch(() => {})
  await admin`DELETE FROM local_credentials WHERE member_sub IN (SELECT sub FROM members WHERE tenant_id = ${t.id})`.catch(() => {})
  await admin`DELETE FROM invites WHERE tenant_id = ${t.id}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${t.id}`.catch(() => {})
  await admin`DELETE FROM tenant_login_prefs WHERE tenant_id = ${t.id}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${t.id}`.catch(() => {})
}

const mkTenant = async (slug: string, plan = 'business'): Promise<string> => {
  madeSlugs.push(slug)
  const [t] = await admin<{ id: string }[]>`INSERT INTO tenants (slug, plan) VALUES (${slug}, ${plan}) RETURNING id`
  return t!.id
}

const ledgerActions = async (tenantId: string): Promise<string[]> =>
  (await admin<{ action: string }[]>`SELECT action FROM operator_audit_log WHERE target = ${`tenant:${tenantId}`} ORDER BY seq`)
    .map((r) => r.action)

beforeAll(async () => { app = await buildApp(); await app.ready() }, 60_000)
afterAll(async () => {
  for (const s of madeSlugs) await dropTenant(s)
  await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#863 / ADR-258: local-admin --domain', () => {
  it('a reserved-label host with no workspace behind it resolves after registration, and 404s before it', async () => {
    const slug = `co863a${STAMP}`
    const tenantId = await mkTenant(slug)
    const host = `docs-${STAMP}.example.com`

    // Break-check named in §5: skip the mirror write and the request is refused as a workspace that
    // does not exist.
    const before = await app.inject({ method: 'GET', url: '/me/settings', headers: { host } })
    expect(before.statusCode, 'no mapping yet — refused as unknown, not as unauthenticated').toBe(404)

    await registerCustomDomainByOperator(tenantId, host)

    const after = await app.inject({ method: 'GET', url: '/me/settings', headers: { host } })
    // Past the tenant hook now — refused for lack of a session, never for lack of a workspace.
    expect(after.statusCode, 'the hook resolved a tenant; the 404 gone').not.toBe(404)
  }, 60_000)

  it('is idempotent: one row, one mirror, and does not reset a row the operator has since changed', async () => {
    const slug = `co863b${STAMP}`
    const tenantId = await mkTenant(slug)
    const host = `idem-${STAMP}.example.com`

    await registerCustomDomainByOperator(tenantId, host)
    // simulate the sweep or a manual verify having touched the row since
    await admin`UPDATE custom_domains SET check_failures = 7, last_ok_at = now() - interval '3 hours'
                WHERE tenant_id = ${tenantId} AND domain = ${host}`

    await registerCustomDomainByOperator(tenantId, host) // second run

    const rows = await admin<{ check_failures: number }[]>`
      SELECT check_failures FROM custom_domains WHERE tenant_id = ${tenantId} AND domain = ${host}`
    expect(rows, 'exactly one row').toHaveLength(1)
    expect(rows[0]!.check_failures, 'the second run did not reset what changed since the first').toBe(7)
    const [t] = await admin<{ custom_domain: string | null }[]>`SELECT custom_domain FROM tenants WHERE id = ${tenantId}`
    expect(t!.custom_domain).toBe(host)
  }, 60_000)

  it('refuses a host whose first label is another workspace\'s slug, and that workspace keeps resolving', async () => {
    const holderSlug = `co863acme${STAMP}`
    await mkTenant(holderSlug)
    const targetId = await mkTenant(`co863handbook${STAMP}`)
    const host = `${holderSlug}.example.com`

    await expect(registerCustomDomainByOperator(targetId, host))
      .rejects.toMatchObject({ statusCode: 409, code: 'slug_conflict' })

    // and the holder still resolves through its OWN slug afterwards (a refusal is only worth having
    // if what it protects still works)
    const r = await app.inject({ method: 'GET', url: '/me/settings', headers: { host: `${holderSlug}.localhost` } })
    expect(r.statusCode).not.toBe(404)
  }, 60_000)

  it('refuses a host another workspace already holds, naming the holder — including across a promoted schema', async () => {
    // ADR-258 §5: "the fixture has to silence TWO constraints" — `custom_domains.domain UNIQUE`
    // (silenced by promoting the holder, below) AND `tenants.custom_domain UNIQUE` (the mirror). A
    // holder with only ONE verified domain leaves the mirror pointed at `host` too, so a target
    // registering `host` would still 23505 when the MIRROR row is written even with the all-tenant walk deleted
    // — a constraint answering "for free" rather than the walk this pin claims to guard. The holder
    // therefore carries a SECOND, strictly newer verified domain, which `syncDomainMapping`'s
    // `ORDER BY verified_at DESC LIMIT 1` puts in the mirror instead, leaving `host` in no
    // constraint at all — only the application's own walk can still refuse it.
    const holderSlug = `co863handbook2_${STAMP}`
    const holderId = await mkTenant(holderSlug)
    const targetId = await mkTenant(`co863target${STAMP}`)
    const host = `docs2-${STAMP}.example.com` // reserved-shaped label, nobody's slug — reaches the walk
    const holderSecondHost = `handbook2-other-${STAMP}.example.com`

    // The holder is PROMOTED to its own namespace schema — `UNIQUE (domain)` cannot see a row that
    // lives in ns_<holder>, so this is the case the plain constraint would miss.
    await provisionNamespaceSchema(holderId, admin)
    await promoteTenantToNamespace({ id: holderId, slug: holderSlug, plan: 'business', isolation: 'logical' } as Tenant, admin)
    await admin`UPDATE tenants SET isolation = 'namespace' WHERE id = ${holderId}`
    await registerCustomDomainByOperator(holderId, host)
    await registerCustomDomainByOperator(holderId, holderSecondHost)
    // Force the ordering deterministically rather than relying on two `now()`s landing apart —
    // ADR-258 §5: "a tie lets the ordering fall back on the target host … which is a false green."
    // Written directly (mirroring this file's other `UPDATE custom_domains SET …` fixtures) because
    // `syncDomainMapping` is module-private and re-registering does not touch an existing row's
    // `verified_at` (§5 idempotency).
    await admin`UPDATE custom_domains SET verified_at = now() + interval '1 second'
                WHERE tenant_id = ${holderId} AND domain = ${holderSecondHost}`
    await admin`UPDATE tenants SET custom_domain = ${holderSecondHost} WHERE id = ${holderId}`

    // Assert the pin's own premises before relying on them — ADR-258 §5: "the moment either drifts
    // this goes back to being green for the wrong reason."
    const noPublicRow = await admin`SELECT 1 FROM custom_domains WHERE domain = ${host}`
    expect(noPublicRow, 'no public.custom_domains row for host — UNIQUE(domain) has nothing to say').toHaveLength(0)
    const [holderMirror] = await admin<{ custom_domain: string | null }[]>`SELECT custom_domain FROM tenants WHERE id = ${holderId}`
    expect(holderMirror!.custom_domain, 'the mirror points at the SECOND domain, not host').toBe(holderSecondHost)

    const rejection = await registerCustomDomainByOperator(targetId, host).catch((e: unknown) => e)
    expect(rejection, 'the app\'s own walk refuses, not a bare constraint violation').toMatchObject({ statusCode: 409, code: 'domain_taken' })
    expect((rejection as { code?: string }).code, 'never the raw Postgres unique_violation').not.toBe('23505')

    // the row itself lives in the holder's own schema, not in public
    const inSchema = await admin.unsafe(
      `SELECT 1 FROM ${namespaceSchema(holderId)}.custom_domains WHERE domain = $1`, [host],
    ) as unknown as unknown[]
    expect(inSchema, 'the promoted holder\'s row is in its own schema').toHaveLength(1)
    const inPublic = await admin`SELECT 1 FROM custom_domains WHERE domain = ${host} AND tenant_id != ${holderId}`
    expect(inPublic, 'and never leaked into public under anyone else').toHaveLength(0)
  }, 60_000)

  it('the row lands in a promoted tenant\'s own schema, not public', async () => {
    const slug = `co863ns${STAMP}`
    const tenantId = await mkTenant(slug)
    await provisionNamespaceSchema(tenantId, admin)
    await promoteTenantToNamespace({ id: tenantId, slug, plan: 'business', isolation: 'logical' } as Tenant, admin)
    await admin`UPDATE tenants SET isolation = 'namespace' WHERE id = ${tenantId}`
    const host = `ns-${STAMP}.example.com`

    await registerCustomDomainByOperator(tenantId, host)

    const inSchema = await admin.unsafe(
      `SELECT 1 FROM ${namespaceSchema(tenantId)}.custom_domains WHERE domain = $1`, [host],
    ) as unknown as unknown[]
    expect(inSchema).toHaveLength(1)
    const inPublic = await admin`SELECT 1 FROM custom_domains WHERE domain = ${host}`
    expect(inPublic, 'absent from public.custom_domains — promotion leaves no NEW row there').toHaveLength(0)
  }, 60_000)

  it('the sweep leaves a shell-registered domain alone, and still demotes a route-registered one', async () => {
    const slug = `co863sweep${STAMP}`
    const tenantId = await mkTenant(slug, 'pro')
    const shellHost = `shell-${STAMP}.example.com`
    const routeHost = `route-${STAMP}.example.com`

    await registerCustomDomainByOperator(tenantId, shellHost)

    const { acquireTenantDb } = await import('../db/index.js')
    const tdb = await acquireTenantDb(asTenant(tenantId, 'pro'))
    try {
      await addCustomDomain(tdb, { tenantId, plan: 'pro', domain: routeHost })
      const [tok] = await admin<{ verification_token: string }[]>`
        SELECT verification_token FROM custom_domains WHERE domain = ${routeHost}`
      await verifyCustomDomain(tdb, { tenantId, domain: routeHost }, { resolveTxt: async () => [[tok!.verification_token]] })
    } finally {
      await tdb.release()
    }

    // Both rows are now `verified`. A failing resolver, run past the grace window and the failure
    // count, must demote ONLY the route-registered one.
    await admin`UPDATE custom_domains SET last_ok_at = now() - interval '48 hours', check_failures = 2
                WHERE domain IN (${shellHost}, ${routeHost})`

    const res = await recheckCustomDomains({ resolveTxt: async () => [], now: new Date() })
    expect(res.demoted, 'the route-registered domain lost its proof and is demoted').toContain(routeHost)
    expect(res.demoted, 'the shell-registered domain has no TXT record to find — it is never checked at all').not.toContain(shellHost)

    const [shellRow] = await admin<{ status: string }[]>`SELECT status FROM custom_domains WHERE domain = ${shellHost}`
    expect(shellRow!.status).toBe('verified')
  }, 60_000)

  it('verifying a second domain through the web route after a shell registration moves the mirror', async () => {
    const slug = `co863order${STAMP}`
    const tenantId = await mkTenant(slug, 'pro')
    const shellHost = `first-${STAMP}.example.com`
    const webHost = `second-${STAMP}.example.com`

    await registerCustomDomainByOperator(tenantId, shellHost)
    let [t] = await admin<{ custom_domain: string | null }[]>`SELECT custom_domain FROM tenants WHERE id = ${tenantId}`
    expect(t!.custom_domain, 'the shell registration set verified_at, so it wins the mirror at birth').toBe(shellHost)

    const { acquireTenantDb } = await import('../db/index.js')
    const tdb = await acquireTenantDb(asTenant(tenantId, 'pro'))
    try {
      await addCustomDomain(tdb, { tenantId, plan: 'pro', domain: webHost })
      const [tok] = await admin<{ verification_token: string }[]>`
        SELECT verification_token FROM custom_domains WHERE domain = ${webHost}`
      await verifyCustomDomain(tdb, { tenantId, domain: webHost }, { resolveTxt: async () => [[tok!.verification_token]] })
    } finally {
      await tdb.release()
    }

    ;[t] = await admin<{ custom_domain: string | null }[]>`SELECT custom_domain FROM tenants WHERE id = ${tenantId}`
    expect(t!.custom_domain, 'the later web-verified domain takes the mirror — the operator moved their own entrance').toBe(webHost)
  }, 60_000)

  it('the row and the mirror are one transaction: a mid-transaction mirror-write failure leaves no custom_domains row', async () => {
    // ADR-258 §5 / §3.1: "the row and the mirror are one transaction … make the `tenants` mirror
    // write fail and assert no `custom_domains` row survives." The failure has to be injected INSIDE
    // the transaction rather than staged in the data — giving another tenant the same mirror value
    // would trip §3.2's cross-tenant walk first, measuring the refusal instead of the atomicity (§5
    // says so explicitly). A CHECK constraint on the exact mirror value is a failure with no data
    // dependency: it only fires on the `UPDATE tenants SET custom_domain = …` inside
    // `syncDomainMapping`, after the `custom_domains` INSERT in the SAME `withTenantTx` transaction.
    const slug = `co863atomic${STAMP}`
    const tenantId = await mkTenant(slug)
    const host = `atomic-${STAMP}.example.com`
    const guard = `co863_atomicity_guard_${STAMP}`

    await admin.unsafe(`ALTER TABLE tenants ADD CONSTRAINT ${guard} CHECK (custom_domain IS DISTINCT FROM '${host}')`)
    try {
      await expect(registerCustomDomainByOperator(tenantId, host)).rejects.toThrow()
    } finally {
      await admin.unsafe(`ALTER TABLE tenants DROP CONSTRAINT ${guard}`)
    }

    const rows = await admin`SELECT 1 FROM custom_domains WHERE tenant_id = ${tenantId} AND domain = ${host}`
    expect(rows, 'the mirror write failed inside the transaction — the row must not survive it').toHaveLength(0)
    const [t] = await admin<{ custom_domain: string | null }[]>`SELECT custom_domain FROM tenants WHERE id = ${tenantId}`
    expect(t!.custom_domain, 'and the mirror itself was never set').toBeNull()
  }, 60_000)

  it('local-admin --domain registers the domain, prints the DNS hand-off, and records a third ledger entry', async () => {
    const slug = `co863cli${STAMP}`
    madeSlugs.push(slug)
    const host = `cli-${STAMP}.example.com`
    const { renderLocalAdmin } = await import('../scripts/local-admin.js')

    const res = await createLocalAdmin(admin, {
      slug, email: `first-${STAMP}@e2e.test`, create: true, plan: 'business', by: 'probe',
      origin: 'https://x.e2e.test', domain: host,
    })
    expect(res.registeredDomain).toBe(host)
    expect(await ledgerActions(res.tenantId)).toEqual([
      'tenant.local_admin_created', 'tenant.custom_domain_registered_by_operator',
    ])
    const printed = renderLocalAdmin(res).join('\n')
    expect(printed, 'the DNS hand-off is printed, not left implicit').toMatch(/point .* at this server/)
    expect(printed).toContain(host)
  }, 120_000)
})

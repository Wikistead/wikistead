// #554 S1 / ADR-197 §1-2: connections get identities and the resolver learns to answer as a LIST.
// N=1 behavior stays byte-identical (the ADR-195 suites pin that); what THIS file pins:
//   - minted ids: a row created through the legacy admin surface carries a uuid, NEVER the tenant id
//     (review B4 — tenant ids must not surface on the unauthenticated login screen);
//   - the legacy surface stays single-row: a second save UPDATES the same row (same id, count 1);
//   - (the bootstrap-eligibility clause retired with the mechanism — #616 / ADR-212 slice 2),
//     FALSE by default on a directly-inserted extra connection (ADR-197 §2 rev2 — an explicit trust
//     attribute, set only where connections are created);
//   - resolveLoginConnections: ordered (sort, id), ceiling-respecting, enabled-only, SAML entitled-
//     only and never bootstrap-eligible, platform appended last under the lapse rule.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { updateTenantOidc, type DiscoveryFetch } from '../routes/tenant-oidc.js'
import { resolveLoginConnections } from '../auth/login-methods.js'
import { provisionTenant } from '../auth/provisioning.js'
import { registerSamlEntitlement, resetSamlEntitlement } from '../auth/saml-entitlement.js'
import { resolveEntitlements } from '@wikistead/entitlements'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const asTenant = (id: string, plan = 'business'): Tenant => ({ id, slug: id, plan, isolation: 'logical' }) as Tenant
const fakeDiscovery: DiscoveryFetch = async () => ({
  authorization_endpoint: 'https://idp.example/authorize',
  token_endpoint: 'https://idp.example/token',
  jwks_uri: 'https://idp.example/jwks',
})

let tenantId = ''
let db: TenantDb
let adminSub = ''

beforeAll(async () => {
  // The SAML rows here are an EE-composed premise: samlEntitled is a registered predicate, CE
  // default false (#693). This file ships in the CE build, where no setup registers the EE
  // predicate — register the composition per file (the seam test pins the CE default). The
  // entitlements-resolver override below still bites: this predicate reads through it.
  registerSamlEntitlement((t) => resolveEntitlements(t.plan).samlSso)
  adminSub = `lc554-admin-${STAMP}`
  const t = await provisionTenant(fgaClient, { slug: `lc554-${STAMP}`, admin: { sub: adminSub } })
  tenantId = t.tenantId
  db = await acquireTenantDb(asTenant(tenantId))
}, 60_000)

afterAll(async () => {
  resetSamlEntitlement()
  await db.release()
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end()
  await pool.end()
}, 60_000)

const save = (enabled: boolean) =>
  updateTenantOidc(db, fgaClient, {
    tenantId, userId: adminSub, issuer: 'https://idp.example', clientId: 'c1',
    redirectUri: 'https://app.example/auth/callback', enabled, plan: 'business',
  }, fakeDiscovery)

describe('#554 S1: connection identities and the list resolver', () => {
  // #616 / ADR-212 slice 2: the bootstrap-eligibility clause is RETIRED BY NAME, not quietly dropped.
  // It asserted that this surface stamped `bootstrap_eligible = true` on every row it minted — which is
  // how rows kept appearing for a mechanism nobody was choosing, and is exactly what the retirement
  // removes. What survives is the identity property the case is named for.
  it('the legacy admin surface mints a uuid id (never the tenant id) and stays single-row across saves', async () => {
    await save(true)
    const rows1 = await admin<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE tenant_id = ${tenantId}`
    expect(rows1.length).toBe(1)
    expect(rows1[0]!.id).not.toBe(tenantId)
    expect(rows1[0]!.id).toMatch(/^[0-9a-f-]{36}$/)

    await save(true) // second save = update, not a sibling row
    const rows2 = await admin<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE tenant_id = ${tenantId}`
    expect(rows2.length, 'still one row').toBe(1)
    expect(rows2[0]!.id, 'the same connection, updated in place').toBe(rows1[0]!.id)
  }, 60_000)

  it('resolveLoginConnections: ordered list, enabled-only, ceiling-respecting', async () => {
    // a second connection, inserted where connections are created (no legacy surface for it yet — S4)
    // S3 review N5: force the second row's id LEXICOGRAPHICALLY SMALLER than the first's, so the
    // sort-order pin cannot pass by id-order coincidence (dropping `sort` must go RED).
    const [firstRow] = await admin<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE tenant_id = ${tenantId} ORDER BY sort, id LIMIT 1`
    const secondId = firstRow!.id > '0' ? '0' + randomUUID().slice(1) : randomUUID()
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, redirect_uri, enabled, sort)
      VALUES (${secondId}, ${tenantId}, 'https://idp2.example', 'c2', 'https://app.example/auth/callback', true, 1)`
    try {
      const list = await resolveLoginConnections(db, { plan: 'business' }, 'tenant-oidc')
      expect(list.map((c) => c.kind)).toEqual(['oidc', 'oidc'])
      expect(list[1]!.id).toBe(secondId)
      // the eligibility assertions retired with the mechanism (#616 / ADR-212 slice 2); the ORDER they
      // rode on is the property this case is named for, and it stays
      expect(list[0]!.id, 'the legacy surface row sorts first (sort 0)').not.toBe(secondId)

      // disabled rows drop out
      await admin`UPDATE tenant_oidc SET enabled = false WHERE id = ${secondId}`
      const afterDisable = await resolveLoginConnections(db, { plan: 'business' }, 'tenant-oidc')
      expect(afterDisable.map((c) => c.id)).not.toContain(secondId)

      // the ceiling excludes the whole kind
      const ceilingOut = await resolveLoginConnections(db, { plan: 'business' }, 'saml')
      expect(ceilingOut.filter((c) => c.kind === 'oidc')).toEqual([])
    } finally {
      await admin`DELETE FROM tenant_oidc WHERE id = ${secondId}`
    }
  }, 60_000)

  it('SAML: listed only when entitled, with its own minted id', async () => {
    const samlId = randomUUID()
    // Clear this tenant's row before claiming it (#797). The tenant is minted per run, so today this
    // deletes nothing — it is here because the table holds ONE row per tenant, and the day somebody
    // gives this file a stable slug the residue of a killed run would otherwise make it red forever.
    await admin`DELETE FROM tenant_saml WHERE tenant_id = ${tenantId}`
    await admin`INSERT INTO tenant_saml (id, tenant_id, idp_entity_id, sso_url, idp_cert_enc, sp_entity_id, acs_url, enabled)
      VALUES (${samlId}, ${tenantId}, 'https://idp.example/meta', 'https://idp.example/sso', 'enc', 'https://wks/sp', 'https://wks/acs', true)`
    try {
      const entitled = await resolveLoginConnections(db, { plan: 'business' }, 'tenant-oidc,saml')
      const saml = entitled.find((c) => c.kind === 'saml')
      expect(saml?.id).toBe(samlId)
      // CE's default resolver is UNLIMITED — the entitlement gate needs a managed-style resolver
      const { registerEntitlementsResolver, resetEntitlementsResolver, resolveEntitlements } = await import('@wikistead/entitlements')
      const unlimited = resolveEntitlements('business')
      registerEntitlementsResolver((plan) => ({ ...unlimited, samlSso: plan !== 'free' }))
      try {
        const unentitled = await resolveLoginConnections(db, { plan: 'free' }, 'tenant-oidc,saml')
        expect(unentitled.find((c) => c.kind === 'saml'), 'entitlement gate').toBeUndefined()
      } finally {
        resetEntitlementsResolver()
      }
    } finally {
      await admin`DELETE FROM tenant_saml WHERE id = ${samlId}`
    }
  }, 60_000)

  it('platform: appended last when in ceiling and configured; the platform-off pref bites only while an own IdP is effective', async () => {
    process.env.PLATFORM_OIDC_ISSUER = 'https://platform.example'
    process.env.PLATFORM_OIDC_CLIENT_ID = 'pc'
    process.env.PLATFORM_OIDC_REDIRECT_URI = 'https://app.example/auth/callback'
    try {
      const list = await resolveLoginConnections(db, { plan: 'business' })
      expect(list[list.length - 1], 'platform last').toMatchObject({ id: 'platform', kind: 'platform' })
      expect(list.some((c) => c.kind === 'oidc'), 'own IdP present').toBe(true)

      await admin`INSERT INTO tenant_login_prefs (tenant_id, platform_login_disabled) VALUES (${tenantId}, true)
        ON CONFLICT (tenant_id) DO UPDATE SET platform_login_disabled = true`
      const enforced = await resolveLoginConnections(db, { plan: 'business' })
      expect(enforced.some((c) => c.kind === 'platform'), 'SSO enforcement drops platform while own IdP lives').toBe(false)

      // the lapse: no own IdP effective → platform returns despite the stored pref
      const lapsed = await resolveLoginConnections(db, { plan: 'business' }, 'platform-oidc')
      expect(lapsed.map((c) => c.kind), 'platform lapses back open').toEqual(['platform'])
    } finally {
      await admin`DELETE FROM tenant_login_prefs WHERE tenant_id = ${tenantId}`.catch(() => {})
      for (const k of ['PLATFORM_OIDC_ISSUER', 'PLATFORM_OIDC_CLIENT_ID', 'PLATFORM_OIDC_REDIRECT_URI']) delete process.env[k]
    }
  }, 60_000)
})

// #554 S1 review A: the old ON CONFLICT (tenant_id) carried a DB-level single-row guarantee; the
// N-capable table must restore it in code — two CONCURRENT first saves race the read-then-insert
// and would mint two connections (one an enabled, bootstrap-eligible orphan no legacy read shows).
describe('#554 S1 review A: concurrent first saves mint exactly one connection', () => {
  it('two parallel saves on a fresh tenant land on one row', async () => {
    const sub2 = `lc554b-admin-${STAMP}`
    const t2 = await provisionTenant(fgaClient, { slug: `lc554b-${STAMP}`, admin: { sub: sub2 } })
    const db2 = await acquireTenantDb(asTenant(t2.tenantId))
    try {
      const one = () => updateTenantOidc(db2, fgaClient, {
        tenantId: t2.tenantId, userId: sub2, issuer: 'https://idp.example', clientId: 'c1',
        redirectUri: 'https://app.example/auth/callback', enabled: true, plan: 'business',
      }, fakeDiscovery)
      await Promise.all([one(), one()])
      const rows = await admin<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE tenant_id = ${t2.tenantId}`
      expect(rows.length, 'the advisory lock serializes the race — one connection, not an orphan pair').toBe(1)
    } finally {
      await db2.release()
      await admin`DELETE FROM tenants WHERE id = ${t2.tenantId}`.catch(() => {})
    }
  }, 60_000)
})

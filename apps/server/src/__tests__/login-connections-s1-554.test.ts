// #554 S1 / ADR-197 §1-2: connections get identities and the resolver learns to answer as a LIST.
// N=1 behavior stays byte-identical (the ADR-195 suites pin that); what THIS file pins:
//   - minted ids: a row created through the legacy admin surface carries a uuid, NEVER the tenant id
//     (review B4 — tenant ids must not surface on the unauthenticated login screen);
//   - the legacy surface stays single-row: a second save UPDATES the same row (same id, count 1);
//   - bootstrap_eligible: TRUE on the legacy-surface connection (today's exact bootstrap behavior),
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
  adminSub = `lc554-admin-${STAMP}`
  const t = await provisionTenant(fgaClient, { slug: `lc554-${STAMP}`, admin: { sub: adminSub } })
  tenantId = t.tenantId
  db = await acquireTenantDb(asTenant(tenantId))
}, 60_000)

afterAll(async () => {
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
  it('the legacy admin surface mints a uuid id (never the tenant id), stays single-row across saves, and is bootstrap-eligible', async () => {
    await save(true)
    const rows1 = await admin<{ id: string; bootstrap_eligible: boolean }[]>`
      SELECT id, bootstrap_eligible FROM tenant_oidc WHERE tenant_id = ${tenantId}`
    expect(rows1.length).toBe(1)
    expect(rows1[0]!.id).not.toBe(tenantId)
    expect(rows1[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows1[0]!.bootstrap_eligible, 'the legacy tenant-IdP surface keeps today\'s bootstrap behavior').toBe(true)

    await save(true) // second save = update, not a sibling row
    const rows2 = await admin<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE tenant_id = ${tenantId}`
    expect(rows2.length, 'still one row').toBe(1)
    expect(rows2[0]!.id, 'the same connection, updated in place').toBe(rows1[0]!.id)
  }, 60_000)

  it('resolveLoginConnections: ordered list, enabled-only, ceiling-respecting; a second row defaults bootstrap_eligible=false', async () => {
    // a second connection, inserted where connections are created (no legacy surface for it yet — S4)
    const secondId = randomUUID()
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, redirect_uri, enabled, sort)
      VALUES (${secondId}, ${tenantId}, 'https://idp2.example', 'c2', 'https://app.example/auth/callback', true, 1)`
    try {
      const list = await resolveLoginConnections(db, { plan: 'business' }, 'tenant-oidc')
      expect(list.map((c) => c.kind)).toEqual(['oidc', 'oidc'])
      expect(list[0]!.bootstrapEligible, 'legacy surface row first (sort 0), eligible').toBe(true)
      expect(list[1]!.id).toBe(secondId)
      expect(list[1]!.bootstrapEligible, 'a NEW connection is ineligible unless flipped knowingly (§2 rev2)').toBe(false)

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

  it('SAML: listed only when entitled, with its own minted id, never bootstrap-eligible', async () => {
    const samlId = randomUUID()
    await admin`INSERT INTO tenant_saml (id, tenant_id, idp_entity_id, sso_url, idp_cert_enc, sp_entity_id, acs_url, enabled)
      VALUES (${samlId}, ${tenantId}, 'https://idp.example/meta', 'https://idp.example/sso', 'enc', 'https://wks/sp', 'https://wks/acs', true)`
    try {
      const entitled = await resolveLoginConnections(db, { plan: 'business' }, 'tenant-oidc,saml')
      const saml = entitled.find((c) => c.kind === 'saml')
      expect(saml?.id).toBe(samlId)
      expect(saml?.bootstrapEligible, 'SAML never bootstraps in v1 (§2 rev2)').toBe(false)
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

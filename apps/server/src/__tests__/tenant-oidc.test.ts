// Integration test — real Postgres + OpenFGA + a real test OpenID Provider.
// Phase 5e tenant OIDC settings: admin-gated; enabling validates discovery; the
// client secret is write-only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { getTenantOidc, updateTenantOidc, validateIssuer, type DiscoveryFetch } from '../routes/tenant-oidc.js'
import { startTestIssuer, type TestIssuer } from './helpers/oidc-issuer.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const STRANGER = 'oidc-stranger'
const REDIRECT = 'http://dev.localhost/auth/callback'
const BAD_ISSUER = 'http://127.0.0.1:1/' // connection refused → discovery fails fast
let db: TenantDb
let issuer: TestIssuer
// The hardened default (safeFetchJson) is https-only + SSRF-guarded, so it rejects the local
// http/loopback TEST issuer by design (ADR-083 / #181 — asserted directly below). To exercise the
// persist / secret / groups flow against the test issuer, inject a fake discovery fetch that returns
// a valid doc; production always uses the hardened default.
const fakeDiscovery: DiscoveryFetch = async () => ({
  authorization_endpoint: `${issuer.url}/authorize`,
  token_endpoint: `${issuer.url}/token`,
  jwks_uri: `${issuer.url}/jwks`,
})

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  issuer = await startTestIssuer({ clientId: 'wikistead-tenant' })
}, 30_000)
afterAll(async () => {
  await issuer.close()
  await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
}, 30_000)

describe('tenant OIDC settings', () => {
  it('validateIssuer: a valid discovery doc passes (endpoint check); an unreachable issuer fails', async () => {
    expect(await validateIssuer(issuer.url, fakeDiscovery)).toBeNull() // endpoints present → ok
    expect(await validateIssuer(BAD_ISSUER)).toBeTruthy()
    // missing-endpoints doc is rejected even via the injected path (the parse/contract check).
    expect(await validateIssuer(issuer.url, (async () => ({})) as DiscoveryFetch)).toBeTruthy()
  })

  it('validateIssuer (real default path) REJECTS an http / loopback issuer — SSRF + https policy (ADR-083 #181)', async () => {
    // The test issuer is http://127.0.0.1 — exactly what the SSRF guard must refuse by default. This
    // exercises the real wiring (validateIssuer → safeFetchJson → resolveGuarded), not the injected fake.
    const err = await validateIssuer(issuer.url)
    expect(err).toBeTruthy() // https-only/loopback-blocked → not null
    expect(await validateIssuer('http://example.com/')).toBe('issuer must be an https URL')
  })

  it('a non-admin cannot update (403)', async () => {
    await expect(updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: STRANGER, issuer: issuer.url, clientId: 'c', redirectUri: REDIRECT, enabled: false,
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('enabling validates discovery: a bad issuer is rejected (400), a real one succeeds', async () => {
    await expect(updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', issuer: BAD_ISSUER, clientId: 'c', redirectUri: REDIRECT, enabled: true,
    })).rejects.toMatchObject({ statusCode: 400, code: 'oidc_unreachable' }) // real path rejects (http)

    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', issuer: issuer.url, clientId: 'wikistead-tenant',
      clientSecret: 'top-secret', redirectUri: REDIRECT, enabled: true,
    }, fakeDiscovery)
    const v = await getTenantOidc(db)
    expect(v).toMatchObject({ issuer: issuer.url, clientId: 'wikistead-tenant', enabled: true, hasSecret: true })
    // The secret is never exposed by the read.
    expect(JSON.stringify(v)).not.toContain('top-secret')
  })

  it('the secret is write-only: a blank value keeps it, an explicit null clears it', async () => {
    // No secret supplied → keep the stored one.
    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', issuer: issuer.url, clientId: 'wikistead-tenant', redirectUri: REDIRECT, enabled: false,
    })
    expect((await getTenantOidc(db))?.hasSecret).toBe(true)
    // Explicit null → clear (public client).
    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', issuer: issuer.url, clientId: 'wikistead-tenant', clientSecret: null, redirectUri: REDIRECT, enabled: false,
    })
    expect((await getTenantOidc(db))?.hasSecret).toBe(false)
  })

  it('groups_claim round-trips; blank → null (default groups) (#102)', async () => {
    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', issuer: issuer.url, clientId: 'wikistead-tenant', redirectUri: REDIRECT, enabled: false, groupsClaim: 'roles',
    })
    expect((await getTenantOidc(db))?.groupsClaim).toBe('roles')
    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', issuer: issuer.url, clientId: 'wikistead-tenant', redirectUri: REDIRECT, enabled: false, groupsClaim: '  ',
    })
    expect((await getTenantOidc(db))?.groupsClaim).toBeNull() // blank → null → default 'groups'
  })
})

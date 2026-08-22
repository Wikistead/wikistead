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

/**
 * #820: the password door, made deterministic the way the SAML row and the platform IdP already were.
 * Returns what it found so the caller can put the shared fixture tenant back — the whole point is not
 * to leave the next file guessing, which is what made this pin order-dependent in the first place.
 */
async function setLocalLogin(enabled: boolean): Promise<boolean> {
  const [row] = await admin<{ local_login_enabled: boolean }[]>`
    SELECT local_login_enabled FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`
  await admin`UPDATE tenant_login_prefs SET local_login_enabled = ${enabled} WHERE tenant_id = ${TENANT}`
  return !!row?.local_login_enabled // no row at all means no password door, which is `false`
}
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
  // #537: the lockout guard refuses an enabled→disabled write when NOTHING else is effective. The
  // write-only-secret / groups tests below toggle enabled freely and are not about lockout, so give
  // them a platform escape hatch; the dedicated lockout pins remove it explicitly.
  process.env.PLATFORM_OIDC_ISSUER = 'https://platform.example'
  process.env.PLATFORM_OIDC_CLIENT_ID = 'pc'
  process.env.PLATFORM_OIDC_REDIRECT_URI = REDIRECT
}, 30_000)
afterAll(async () => {
  for (const k of ['PLATFORM_OIDC_ISSUER', 'PLATFORM_OIDC_CLIENT_ID', 'PLATFORM_OIDC_REDIRECT_URI']) delete process.env[k]
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
      tenantId: TENANT, userId: STRANGER, plan: 'free', issuer: issuer.url, clientId: 'c', redirectUri: REDIRECT, enabled: false,
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('enabling validates discovery: a bad issuer is rejected (400), a real one succeeds', async () => {
    await expect(updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', plan: 'free', issuer: BAD_ISSUER, clientId: 'c', redirectUri: REDIRECT, enabled: true,
    })).rejects.toMatchObject({ statusCode: 400, code: 'oidc_unreachable' }) // real path rejects (http)

    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', plan: 'free', issuer: issuer.url, clientId: 'wikistead-tenant',
      clientSecret: 'top-secret', redirectUri: REDIRECT, enabled: true,
    }, fakeDiscovery)
    const v = await getTenantOidc(db)
    expect(v).toMatchObject({ issuer: issuer.url, clientId: 'wikistead-tenant', enabled: true, hasSecret: true })
    // The secret is never exposed by the read.
    expect(JSON.stringify(v)).not.toContain('top-secret')
  })

  it('the secret is write-only: a blank value keeps it, an explicit null clears it', async () => {
    // No secret supplied → keep the stored one. ⚠️ `confirm`: the previous case left this connection
    // enabled, so this write CLOSES a door, and ADR-251 / #822 asks about that when what remains is a
    // federated door nobody can promise. The subject here is the secret, not the guard — the guard is
    // measured in its own describe below — so the question is answered rather than avoided.
    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', plan: 'free', issuer: issuer.url, clientId: 'wikistead-tenant', redirectUri: REDIRECT, enabled: false, confirm: true,
    })
    expect((await getTenantOidc(db))?.hasSecret).toBe(true)
    // Explicit null → clear (public client).
    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', plan: 'free', issuer: issuer.url, clientId: 'wikistead-tenant', clientSecret: null, redirectUri: REDIRECT, enabled: false,
    })
    expect((await getTenantOidc(db))?.hasSecret).toBe(false)
  })

  it('groups_claim round-trips; blank → null (default groups) (#102)', async () => {
    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', plan: 'free', issuer: issuer.url, clientId: 'wikistead-tenant', redirectUri: REDIRECT, enabled: false, groupsClaim: 'roles',
    })
    expect((await getTenantOidc(db))?.groupsClaim).toBe('roles')
    await updateTenantOidc(db, fgaClient, {
      tenantId: TENANT, userId: 'dev-user', plan: 'free', issuer: issuer.url, clientId: 'wikistead-tenant', redirectUri: REDIRECT, enabled: false, groupsClaim: '  ',
    })
    expect((await getTenantOidc(db))?.groupsClaim).toBeNull() // blank → null → default 'groups'
  })
})

// #537: the lockout guard. Disabling the tenant IdP while no other method is effective would 404
// every future login and — unlike a broken issuer — pass every discovery check. The TRANSITION is
// refused (409 login_lockout, write not persisted); an already-disabled row may still be edited.
describe('#537 tenant-oidc lockout guard', () => {
  const base = { tenantId: TENANT, userId: 'dev-user', plan: 'free', clientId: 'wikistead-tenant', redirectUri: REDIRECT }
  it('refuses the disable that would empty the effective set; allows it once another method remains', async () => {
    await admin`DELETE FROM tenant_saml WHERE tenant_id = ${TENANT}`.catch(() => {}) // deterministic: saml off
    // #820: the effective set this guard counts has THREE doors and this pin was making only two of
    // them deterministic. The password door is a row on the SHARED fixture tenant, so whether the
    // guard had anything left to count depended on what the last file to touch it happened to leave
    // behind — a run that turned it on and was killed before its cleanup made this assertion fail,
    // and running the file that turns it off again made it pass. Measured both ways: with the row
    // left on, the disable below is correctly ALLOWED and the rejection never comes.
    //
    // The SAML sibling of this pin does NOT need the same line, which is worth knowing rather than
    // copying: its guard asks the kind-level question, which never looks at the password door at all
    // (measured — leaving the row on changes nothing there). That split is filed on its own.
    const localBefore = await setLocalLogin(false)
    await updateTenantOidc(db, fgaClient, { ...base, issuer: issuer.url, enabled: true }, fakeDiscovery)
    const saved = process.env.PLATFORM_OIDC_ISSUER
    delete process.env.PLATFORM_OIDC_ISSUER // no platform → the tenant IdP is the ONLY door
    try {
      await expect(updateTenantOidc(db, fgaClient, { ...base, issuer: issuer.url, enabled: false }))
        .rejects.toMatchObject({ statusCode: 409, code: 'login_lockout' })
      expect((await getTenantOidc(db))?.enabled, 'the refused write persisted nothing').toBe(true)
    } finally {
      process.env.PLATFORM_OIDC_ISSUER = saved
    }
    // With the platform IdP effective again the same disable goes through — but ADR-251 / #822 asks
    // first: one door remains and it is federated, so the product cannot promise anybody can walk
    // through it. Both halves are pinned, because "the guard let it through" and "the guard asked and
    // then let it through" are different products and the older test could not tell them apart.
    await expect(updateTenantOidc(db, fgaClient, { ...base, issuer: issuer.url, enabled: false }))
      .rejects.toMatchObject({ statusCode: 409, code: 'confirm_required' })
    expect((await getTenantOidc(db))?.enabled, 'the unanswered question persisted the write anyway').toBe(true)
    await updateTenantOidc(db, fgaClient, { ...base, issuer: issuer.url, enabled: false, confirm: true })
    expect((await getTenantOidc(db))?.enabled).toBe(false)
    // …and an already-disabled row may be edited even without the escape hatch (no transition).
    delete process.env.PLATFORM_OIDC_ISSUER
    try {
      await updateTenantOidc(db, fgaClient, { ...base, issuer: issuer.url, enabled: false, groupsClaim: 'roles' })
      expect((await getTenantOidc(db))?.groupsClaim).toBe('roles')
    } finally {
      process.env.PLATFORM_OIDC_ISSUER = saved
      await setLocalLogin(localBefore) // put the shared tenant back the way it was found
    }
  })
})

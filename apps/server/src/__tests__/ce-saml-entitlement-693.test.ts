// #693 (ruling): the samlSso entitlement is a REGISTERED predicate, CE default false.
//
// The live failure this pins shut: a CE build resolves entitlements to UNLIMITED (samlSso: true),
// so before the seam, imported data with an enabled `tenant_saml` row made the resolver count a
// SAML door with NO BYTES behind it as an effective own IdP — and the own-IdP arithmetic could then
// suppress platform login (the lockout shape #568 exists to prevent). With the predicate defaulting
// to false, the whole path is unreachable in a CE composition.
//
// NO @wikistead-ee/server import, deliberately: this file states CE behaviour and SHIPS WITH THE
// MIRROR. On the dev suite the setup registers the EE predicate; module state is per-vitest-file,
// so resetting here simulates the CE composition for this file alone. In the CE build nothing was
// registered and the reset is a no-op — both suites measure the same claim.
//
// The `ce-` name is load-bearing (#707): the filter's EE glob excludes `saml*.test.ts` from the
// mirror, and this file must stay OUTSIDE that glob or the mirror never measures the CE default.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import { resolveAvailableLogin } from '../auth/login-methods.js'
import { samlEntitled, resetSamlEntitlement, registerSamlEntitlement } from '../auth/saml-entitlement.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_acme' // its own tenant so no login-methods suite shares the saml row
const tenant = { id: TENANT, slug: 'acme', plan: 'business', isolation: 'logical' } as Tenant
let db: TenantDb
let samlRowId: string
const PRIOR_ENV = process.env.PLATFORM_OIDC_ISSUER

beforeAll(async () => {
  db = await acquireTenantDb(tenant)
  // The scenario the ruling names: an enabled tenant_saml row EXISTS in the data…
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO tenant_saml (id, tenant_id, idp_entity_id, sso_url, idp_cert_enc, sp_entity_id, acs_url, enabled)
    VALUES (gen_random_uuid()::text, ${TENANT}, 'https://idp.example', 'https://idp.example/sso', 'enc', 'https://sp.example', 'https://sp.example/acs', true)
    RETURNING id`
  samlRowId = row!.id
  // …and a platform IdP is configured, so its suppression would be observable.
  process.env.PLATFORM_OIDC_ISSUER = 'https://platform.example'
  process.env.PLATFORM_OIDC_CLIENT_ID = 'wikistead'
  process.env.PLATFORM_OIDC_REDIRECT_URI = 'https://dev.localhost/auth/callback'
}, 60_000)

afterAll(async () => {
  await admin`DELETE FROM tenant_saml WHERE id = ${samlRowId}`.catch(() => {})
  if (PRIOR_ENV === undefined) delete process.env.PLATFORM_OIDC_ISSUER
  else process.env.PLATFORM_OIDC_ISSUER = PRIOR_ENV
  await db.release(); await admin.end(); await pool.end()
}, 60_000)

describe('#693 a CE composition never counts the SAML door', () => {
  it('the predicate answers false when nothing registered — whatever the plan resolves to', () => {
    resetSamlEntitlement() // the CE composition, for this file's module graph
    expect(samlEntitled({ plan: 'business' })).toBe(false)
    expect(samlEntitled({ plan: 'team' })).toBe(false)
  })

  it('an enabled tenant_saml row conjures NO door, and platform login is NOT suppressed', async () => {
    resetSamlEntitlement()
    const available = await resolveAvailableLogin(db, tenant, async () => null)
    expect(available.methods.has('saml'), 'a door with no bytes behind it was counted').toBe(false)
    // The own-IdP arithmetic must not see saml either: with no other own IdP, platform stays a way
    // in (the suppression path the ruling names as the live bug is unreachable).
    expect(available.methods.has('platform-oidc'), 'platform login was suppressed by a byteless door').toBe(true)
  }, 60_000)

  it('a registered predicate opens the same door — the seam carries, the default refuses', async () => {
    // Registering a local closure simulates the EE composition WITHOUT importing EE (this file must
    // ship in the CE build). The real registration reads the entitlement on the EE side.
    registerSamlEntitlement(() => true)
    try {
      const available = await resolveAvailableLogin(db, tenant, async () => null)
      expect(available.methods.has('saml'), 'the registered predicate did not reach the resolver').toBe(true)
    } finally {
      resetSamlEntitlement()
    }
  }, 60_000)
})

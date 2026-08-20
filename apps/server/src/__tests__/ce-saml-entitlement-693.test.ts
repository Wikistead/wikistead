// #693 (ruling): the samlSso entitlement is a REGISTERED predicate, CE default false.
//
// The live failure this pins shut: a CE build resolves entitlements to UNLIMITED (samlSso: true),
// so before the seam, imported data with an enabled `tenant_saml` row made the resolver count a
// SAML door with NO BYTES behind it as an effective own IdP — and the own-IdP arithmetic could then
// suppress platform login (the lockout shape #568 exists to prevent). With the predicate defaulting
// to false, the whole path is unreachable in a CE composition.
//
// NO @wikistead-ee/server import, deliberately: this file states CE behaviour and SHIPS WITH THE
// CE BUILD — which is why it is named ce-saml-entitlement and not saml-*: the filter erases
// `__tests__/saml*.test.ts` by glob, and the first version of this file silently vanished from the
// one repository whose behaviour it pins (#693 ③, measured on a real CE build).
//
// On the dev suite the setup registers the EE predicate; module state is per-vitest-file, so
// resetting here simulates the CE composition for this file alone. In the CE build nothing was
// registered and the reset is a no-op — both suites measure the same claim. The CLI case goes
// further and spawns the SHIPPED process (no vitest setup at all), because the setup's ambient
// registration is exactly how the round-2 defect hid (#693 ①).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
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
let priorPrefs: { platform_login_disabled: boolean } | undefined
const PRIOR_ENV = process.env.PLATFORM_OIDC_ISSUER

beforeAll(async () => {
  db = await acquireTenantDb(tenant)
  // The scenario the ruling names: an enabled tenant_saml row EXISTS in the data…
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO tenant_saml (id, tenant_id, idp_entity_id, sso_url, idp_cert_enc, sp_entity_id, acs_url, enabled)
    VALUES (gen_random_uuid()::text, ${TENANT}, 'https://idp.example', 'https://idp.example/sso', 'enc', 'https://sp.example', 'https://sp.example/acs', true)
    RETURNING id`
  samlRowId = row!.id
  // …a platform IdP is configured, so its suppression would be observable…
  process.env.PLATFORM_OIDC_ISSUER = 'https://platform.example'
  process.env.PLATFORM_OIDC_CLIENT_ID = 'wikistead'
  process.env.PLATFORM_OIDC_REDIRECT_URI = 'https://dev.localhost/auth/callback'
  // …and the tenant has SWITCHED PLATFORM LOGIN OFF, which is the suppression's own precondition.
  // Without this row the platform door stays open in BOTH worlds and the "not suppressed" claim is
  // satisfied by broken code too (#693 ② — the round-2 vacuity).
  ;[priorPrefs] = await admin<{ platform_login_disabled: boolean }[]>`
    SELECT platform_login_disabled FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`
  await admin`
    INSERT INTO tenant_login_prefs (tenant_id, platform_login_disabled) VALUES (${TENANT}, TRUE)
    ON CONFLICT (tenant_id) DO UPDATE SET platform_login_disabled = TRUE`
}, 60_000)

afterAll(async () => {
  await admin`DELETE FROM tenant_saml WHERE id = ${samlRowId}`.catch(() => {})
  if (priorPrefs === undefined) {
    await admin`UPDATE tenant_login_prefs SET platform_login_disabled = FALSE WHERE tenant_id = ${TENANT}`.catch(() => {})
  } else {
    await admin`UPDATE tenant_login_prefs SET platform_login_disabled = ${priorPrefs.platform_login_disabled} WHERE tenant_id = ${TENANT}`.catch(() => {})
  }
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

  it('CE: the byteless door is not counted, so the platform-off preference LAPSES and platform stays open', async () => {
    resetSamlEntitlement()
    const available = await resolveAvailableLogin(db, tenant, async () => null)
    expect(available.methods.has('saml'), 'a door with no bytes behind it was counted').toBe(false)
    // platform_login_disabled=TRUE is in force — but with no own IdP effective, the preference
    // lapses (ADR-210) and platform login remains a way in. This is the half the broken code fails:
    // with samlSso resolving true, the byteless door reads effective and platform is suppressed.
    expect(available.methods.has('platform-oidc'), 'platform login was suppressed by a byteless door').toBe(true)
  }, 60_000)

  it('EE-shaped: the SAME data with the predicate registered counts saml and honours the platform-off switch', async () => {
    // The differential the ruling asked for (#693 ②): identical rows, identical prefs — the
    // ONLY variable is the composition. Registering a local closure simulates the EE composition
    // WITHOUT importing EE (this file ships in the CE build).
    registerSamlEntitlement(() => true)
    try {
      const available = await resolveAvailableLogin(db, tenant, async () => null)
      expect(available.methods.has('saml'), 'the registered predicate did not reach the resolver').toBe(true)
      expect(available.methods.has('platform-oidc'),
        'an effective own IdP plus platform_login_disabled must suppress platform login').toBe(false)
    } finally {
      resetSamlEntitlement()
    }
  }, 60_000)

  it('the SHIPPED CE CLI answers the same — measured as a child process, not through vitest setup', () => {
    // #693 ①: the dev suite's setupFiles register the EE predicate for every test file, so an
    // in-process pin measures a composition the shipped CE CLI never has. This spawns the real
    // thing: `tsx src/scripts/login-methods.ts acme` with no vitest in sight.
    const out = execFileSync('npx', ['tsx', 'src/scripts/login-methods.ts', 'acme'], {
      cwd: resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 120_000,
    })
    const samlLine = out.split('\n').find((l) => l.trim().startsWith('saml'))
    expect(samlLine, `no saml line in:\n${out}`).toBeDefined()
    expect(samlLine!, 'the CE CLI must state the CE truth: blocked by entitlement').toContain('blocker: entitlement')
    const platformLine = out.split('\n').find((l) => l.trim().startsWith('platform-oidc'))
    expect(platformLine!, 'and platform login stays a way in (the lapse)').toContain('EFFECTIVE')
  }, 150_000)
})

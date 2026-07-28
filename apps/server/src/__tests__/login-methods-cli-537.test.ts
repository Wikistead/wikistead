// Integration test (real Postgres) — the whole-picture break-glass (#537 / ADR-195 §10, ruling 5):
// print + set a tenant's login-method selection, ENABLE direction included (the one the per-feature
// disable commands lack). Pins:
//   1. the picture names the blocker per method (ceiling / config / selection / entitlement);
//   2. --enable flips a DISABLED tenant IdP back on and the operator ledger records it (in one tx);
//   3. enable never invents config (no row → error, nothing written);
//   4. it overrides the tenant-side guards (a disable that empties the effective set goes THROUGH —
//      the operator is trusted — but the picture then says the set is EMPTY);
//   5. idempotent: a same-state request is a no-op with no ledger append;
//   6. the ceiling is NOT rewritable from here: a ceiling-blocked method stays ineffective after
//      --enable, and the rendered output names LOGIN_METHODS as the fix.
import { describe, it, expect, afterAll, afterEach } from 'vitest'
import postgres from 'postgres'
import { inspectLoginMethods, recoverLoginMethods, renderPicture } from '../scripts/login-methods.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const created: string[] = []

async function freshTenant(slug: string): Promise<string> {
  const [t] = await admin<{ id: string }[]>`INSERT INTO tenants (slug, plan) VALUES (${slug}, 'free') RETURNING id`
  created.push(t.id)
  return t.id
}
const seedOidc = (tenantId: string, enabled: boolean) =>
  admin`INSERT INTO tenant_oidc (tenant_id, issuer, client_id, redirect_uri, enabled)
    VALUES (${tenantId}, 'https://idp.test/', 'c', 'https://app.test/cb', ${enabled})`
const ledgerCount = async (tenantId: string) =>
  Number((await admin<{ n: string }[]>`SELECT count(*) AS n FROM operator_audit_log WHERE target = ${'tenant:' + tenantId}`)[0]!.n)

afterEach(() => {
  delete process.env.LOGIN_METHODS
  delete process.env.PLATFORM_OIDC_ISSUER
})
afterAll(async () => {
  for (const id of created) {
    await admin`DELETE FROM tenant_login_prefs WHERE tenant_id = ${id}`.catch(() => {})
    await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${id}`.catch(() => {})
    await admin`DELETE FROM tenants WHERE id = ${id}`.catch(() => {})
  }
  await admin.end()
}, 30_000)

describe('tenant:login-methods (break-glass, #537)', () => {
  it('prints the picture with a per-method blocker', async () => {
    const slug = `bg537-pic-${Date.now().toString(36)}`
    const id = await freshTenant(slug)
    await seedOidc(id, false)
    const p = await inspectLoginMethods(admin, { slug })
    expect(p.methods['tenant-oidc']).toMatchObject({ configured: true, selected: false, effective: false, blocker: 'selection' })
    expect(p.methods['platform-oidc'].blocker, 'no platform env in this suite').toBe('config')
    expect(p.methods.saml.blocker).toBe('config')
    expect(p.effectiveSet).toEqual([])
    expect(renderPicture(p)).toContain('EMPTY')
  })

  it('--enable=tenant-oidc flips a disabled IdP back ON and the operator ledger records it in-tx', async () => {
    const slug = `bg537-en-${Date.now().toString(36)}`
    const id = await freshTenant(slug)
    await seedOidc(id, false) // the §10 scenario: config exists, gate off, no admin can log in
    const before = await ledgerCount(id)
    const r = await recoverLoginMethods(admin, { slug, operator: 'op-3am', enable: 'tenant-oidc' })
    expect(r.changed).toBe(true)
    expect(r.picture.methods['tenant-oidc'].effective).toBe(true)
    expect(r.picture.effectiveSet).toContain('tenant-oidc')
    expect(await ledgerCount(id), 'the privileged write is ledgered').toBe(before + 1)
    // Idempotent second run: no change, no ledger spam.
    const again = await recoverLoginMethods(admin, { slug, operator: 'op-3am', enable: 'tenant-oidc' })
    expect(again.changed).toBe(false)
    expect(await ledgerCount(id)).toBe(before + 1)
  })

  it('never invents config: --enable on a config-less tenant errors and writes nothing', async () => {
    const slug = `bg537-nc-${Date.now().toString(36)}`
    const id = await freshTenant(slug)
    await expect(recoverLoginMethods(admin, { slug, operator: 'op', enable: 'saml' }))
      .rejects.toMatchObject({ code: 'no_config' })
    expect(await ledgerCount(id)).toBe(0)
  })

  it('overrides the tenant-side guards: an emptying disable goes through, and the picture says EMPTY', async () => {
    const slug = `bg537-ov-${Date.now().toString(36)}`
    const id = await freshTenant(slug)
    await seedOidc(id, true) // the only effective method
    const r = await recoverLoginMethods(admin, { slug, operator: 'op', disable: 'tenant-oidc' })
    expect(r.changed, 'no 409 here — the operator is trusted').toBe(true)
    expect(r.picture.effectiveSet).toEqual([])
    expect(renderPicture(r.picture)).toContain('EMPTY')
  })

  it('cannot rewrite the ceiling: a ceiling-blocked method stays ineffective and the output names LOGIN_METHODS', async () => {
    const slug = `bg537-ce-${Date.now().toString(36)}`
    const id = await freshTenant(slug)
    await seedOidc(id, false)
    process.env.LOGIN_METHODS = 'platform-oidc,saml' // ceiling drops tenant-oidc
    const r = await recoverLoginMethods(admin, { slug, operator: 'op', enable: 'tenant-oidc' })
    expect(r.picture.methods['tenant-oidc']).toMatchObject({ selected: true, effective: false, blocker: 'ceiling' })
    expect(renderPicture(r.picture)).toContain('LOGIN_METHODS')
  })

  it('--platform-login on/off drives the prefs row (absent row = on)', async () => {
    const slug = `bg537-pl-${Date.now().toString(36)}`
    const id = await freshTenant(slug)
    process.env.PLATFORM_OIDC_ISSUER = 'https://platform.example'
    const off = await recoverLoginMethods(admin, { slug, operator: 'op', platformLogin: 'off' })
    expect(off.picture.methods['platform-oidc']).toMatchObject({ selected: false, effective: false })
    const on = await recoverLoginMethods(admin, { slug, operator: 'op', platformLogin: 'on' })
    expect(on.picture.methods['platform-oidc']).toMatchObject({ selected: true, effective: true })
    expect(await ledgerCount(id)).toBe(2)
  })
})

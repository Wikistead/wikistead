// Integration — real Postgres + real OpenFGA. #616 / ADR-212 slice 1: the operator route that has to
// exist BEFORE the first-login bootstrap can be removed.
//
// The acceptance is end to end and nothing less would do: ADR-212's whole argument is that the
// grandfathered installations keep their only way in until this command replaces it, so "the command
// runs" is not the claim — "the person it invites can actually sign in and administer the tenant" is.
//
// Everything runs on THROWAWAY tenants, made and dropped here, with `members` asserted empty BEFORE the
// act. The shipped `acme` row is the trap ADR-212 records: once it has members the mechanisms under test
// answer false for a different reason and the cases go green measuring nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb } from '../db/index.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { createLocalAdmin, renderLocalAdmin } from '../scripts/local-admin.js'
import { acceptLocalInvite } from '../auth/invites.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const asTenant = (id: string, plan = 'business'): Tenant => ({ id, slug: id, plan, isolation: 'logical' }) as Tenant

const madeSlugs: string[] = []
const cleanup: { user: string; relation: string; object: string }[] = []

/** Drop everything a throwaway tenant leaves behind, in FK order. */
async function dropTenant(slug: string): Promise<void> {
  const [t] = await admin<{ id: string }[]>`SELECT id FROM tenants WHERE slug = ${slug}`
  if (!t) return
  await admin`DELETE FROM local_credentials WHERE member_sub IN (SELECT sub FROM members WHERE tenant_id = ${t.id})`.catch(() => {})
  await admin`DELETE FROM invites WHERE tenant_id = ${t.id}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${t.id}`.catch(() => {})
  await admin`DELETE FROM tenant_login_prefs WHERE tenant_id = ${t.id}`.catch(() => {})
  await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${t.id}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${t.id}`.catch(() => {})
}

beforeAll(async () => { /* nothing shared — each case owns its tenant */ }, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, cleanup).catch(() => {})
  for (const s of madeSlugs) await dropTenant(s)
  await admin.end(); await pool.end()
}, 180_000)

const memberCount = async (tenantId: string): Promise<number> =>
  Number((await admin<{ n: string }[]>`SELECT count(*) AS n FROM members WHERE tenant_id = ${tenantId}`)[0]!.n)

const ledgerActions = async (tenantId: string): Promise<string[]> =>
  (await admin<{ action: string }[]>`SELECT action FROM operator_audit_log WHERE target = ${`tenant:${tenantId}`} ORDER BY seq`)
    .map((r) => r.action)

describe('#616 ADR-212 slice 1: the operator makes a first admin who can actually get in', () => {
  it('--create mints the tenant, turns password sign-in on, and the invite seats a working admin', async () => {
    const slug = `la616a${STAMP}`
    madeSlugs.push(slug)
    const res = await createLocalAdmin(admin, { slug, email: `first-${STAMP}@e2e.test`, create: true, plan: 'business', by: 'probe', origin: 'https://x.e2e.test' })

    expect(res.created, 'the tenant was made by this act').toBe(true)
    expect(await memberCount(res.tenantId), 'premise: nobody is seated yet — the invite is the entrance').toBe(0)
    expect(res.enabledLocalLogin, 'password sign-in had to be switched on').toBe(true)
    const [prefs] = await admin<{ local_login_enabled: boolean }[]>`
      SELECT local_login_enabled FROM tenant_login_prefs WHERE tenant_id = ${res.tenantId}`
    expect(prefs?.local_login_enabled, '…and the row says so, not just the report').toBe(true)

    // the claim that matters: the invited person signs in and IS an administrator
    const token = new URL(res.inviteUrl).searchParams.get('token')!
    const db = await acquireTenantDb(asTenant(res.tenantId))
    try {
      const accepted = await acceptLocalInvite({ db, fga: fgaClient }, { id: res.tenantId, plan: 'business' }, token, 'la616-passphrase-1')
      expect(accepted.ok, 'the link the operator handed over works').toBe(true)
      if (!accepted.ok) return
      cleanup.push({ user: `user:${accepted.sub}`, relation: 'admin', object: `tenant:${res.tenantId}` })

      const [row] = await admin<{ role: string }[]>`SELECT role FROM members WHERE tenant_id = ${res.tenantId}`
      expect(row?.role, 'seated as an admin').toBe('admin')
      // and the STORE agrees — a members row without the tuple is an admin who cannot do anything
      const { tuples } = await fgaClient.read({ user: `user:${accepted.sub}`, object: `tenant:${res.tenantId}` })
      expect((tuples ?? []).map((t) => t.key?.relation), 'the tenant admin tuple exists').toContain('admin')
    } finally {
      await db.release()
    }

    expect(await ledgerActions(res.tenantId), 'the act is in the operator ledger').toEqual(['tenant.local_admin_created'])
    expect(renderLocalAdmin(res).join('\n'), 'and nothing about a stance, because there was none').not.toMatch(/WARNING/)
  }, 240_000)

  it('without --create it refuses an unknown slug rather than inventing a tenant', async () => {
    await expect(
      createLocalAdmin(admin, { slug: `la616missing${STAMP}`, email: `x-${STAMP}@e2e.test`, by: 'probe' }),
      'a typo in a slug must not silently make a second tenant',
    ).rejects.toThrow(/--create/)
  }, 60_000)

  it('recovering a member-less tenant that requires SSO steps over the stance, says so, and leaves it standing', async () => {
    // The (i) ruling's ONE domain, measured (adminless-invite-probe-616 narrowed it): a password
    // recovery into a tenant that has a working IdP and nobody seated.
    const slug = `la616b${STAMP}`
    madeSlugs.push(slug)
    const [t] = await admin<{ id: string }[]>`
      INSERT INTO tenants (slug, plan) VALUES (${slug}, 'business') RETURNING id`
    const tenantId = t!.id
    await admin`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled, sso_required) VALUES (${tenantId}, false, true)`
    // a REAL federated way in, or the stance lapses and this case measures nothing
    await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, redirect_uri, enabled)
                VALUES (gen_random_uuid(), ${tenantId}, 'https://idp.e2e.test', 'la616', 'https://x.e2e.test/cb', true)`
    expect(await memberCount(tenantId), 'premise: a stranded tenant, nobody seated').toBe(0)

    const res = await createLocalAdmin(admin, { slug, email: `rescue-${STAMP}@e2e.test`, by: 'probe', origin: 'https://x.e2e.test' })
    expect(res.created, 'an existing tenant is recovered, not remade').toBe(false)
    expect(res.steppedOverStance, 'the stance was biting, and this went past it').toBe(true)

    // condition 3: the tenant's policy survives its own rescue
    const [after] = await admin<{ sso_required: boolean }[]>`
      SELECT sso_required FROM tenant_login_prefs WHERE tenant_id = ${tenantId}`
    expect(after?.sso_required, 'the stance itself is NOT rewritten').toBe(true)

    // condition 1: BOTH facts are readable in the ledger, as separate acts
    expect(await ledgerActions(tenantId)).toEqual(['tenant.local_admin_recovered', 'tenant.sso_stance_overridden'])

    // condition 2: the output says it, in the words an operator needs at 3am
    const printed = renderLocalAdmin(res).join('\n')
    expect(printed, 'the override is announced, never silent').toMatch(/WARNING: this tenant requires SSO/)
    expect(printed, 'and the output is clear that the policy still stands').toMatch(/stance itself was NOT changed/)
    expect(printed, 'the link is printed — it is the whole point of the command').toContain(res.inviteUrl)

    // and it really works: the rescued admin gets in
    const token = new URL(res.inviteUrl).searchParams.get('token')!
    const db = await acquireTenantDb(asTenant(tenantId))
    try {
      const accepted = await acceptLocalInvite({ db, fga: fgaClient }, { id: tenantId, plan: 'business' }, token, 'la616-passphrase-2')
      expect(accepted.ok, 'the rescue link is not a link to a refusal').toBe(true)
      if (accepted.ok) cleanup.push({ user: `user:${accepted.sub}`, relation: 'admin', object: `tenant:${tenantId}` })
    } finally {
      await db.release()
    }
  }, 240_000)

  it('a tenant that already offers passwords is not reported as having been changed', async () => {
    // A command that claims to have turned something on when it did not is the same lie as one that
    // stays silent — and this is the line an operator reads to decide what to undo afterwards.
    const slug = `la616c${STAMP}`
    madeSlugs.push(slug)
    const [t] = await admin<{ id: string }[]>`INSERT INTO tenants (slug, plan) VALUES (${slug}, 'business') RETURNING id`
    await admin`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${t!.id}, true)`
    const res = await createLocalAdmin(admin, { slug, email: `already-${STAMP}@e2e.test`, by: 'probe', origin: 'https://x.e2e.test' })
    expect(res.enabledLocalLogin, 'it was already on').toBe(false)
    expect(renderLocalAdmin(res).join('\n')).toContain('password sign-in: already on')
  }, 120_000)
})

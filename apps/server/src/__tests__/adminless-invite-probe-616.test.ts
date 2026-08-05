// #616 / ADR-212 open question 1, answered by measurement rather than by reading.
//
// Slice 1's recovery command mints a tenant plus a PENDING first-admin invite, so the tenant exists
// briefly with no seated admin and the invite is the entrance. Everything about that shape depends on a
// fact nobody had measured: does an invite issued and accepted in a tenant with NO admin actually work?
// `invites.invited_by` has no FK (`013_invites.sql:33`), so the schema does not object — but a schema
// that does not object is not the same as a path that works, and the difference is where slice 1 would
// have been designed on an assumption.
//
// Everything runs on a THROWAWAY tenant. The shipped empty tenant (`acme`) is the trap ADR-212 records:
// once it has members, the mechanism under test returns false for a DIFFERENT reason and the case goes
// green while measuring nothing. So the tenant is made here, asserted member-less BEFORE anything else
// happens, and dropped afterwards.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { createInvite, acceptInvite, acceptLocalInvite } from '../auth/invites.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const TENANT = `t616_${STAMP}`
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let db: TenantDb
const cleanup: { user: string; relation: string; object: string }[] = []

beforeAll(async () => {
  await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${TENANT}, ${TENANT}, 'business', 'logical')`
  db = await acquireTenantDb(asTenant(TENANT))
}, 120_000)

afterAll(async () => {
  await deleteTuples(fgaClient, cleanup).catch(() => {})
  await admin`DELETE FROM local_credentials WHERE member_sub IN (SELECT sub FROM members WHERE tenant_id = ${TENANT})`.catch(() => {})
  await admin`DELETE FROM invites WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await db.release(); await admin.end(); await pool.end()
}, 120_000)

const memberCount = async (): Promise<number> =>
  Number((await admin<{ n: string }[]>`SELECT count(*) AS n FROM members WHERE tenant_id = ${TENANT}`)[0]!.n)

describe('#616 ADR-212 OQ1: an invite in a tenant with no seated admin', () => {
  it('issues and accepts, seating the first member as an admin — the shape slice 1 depends on', async () => {
    // the premise, asserted BEFORE anything happens: this is a genuinely empty tenant
    expect(await memberCount(), 'premise: nobody is seated yet').toBe(0)

    // `invitedBy` names an operator who is not a member — the case slice 1 creates and the reason the
    // missing FK matters
    const operator = `operator:cli-${STAMP}`
    const inv = await createInvite(db, {
      tenantId: TENANT, plan: 'business', invitedBy: operator,
      email: `first-${STAMP}@e2e.test`, role: 'admin',
    })
    expect(inv.token, 'an invite exists to accept').toBeTruthy()

    const sub = `wc0000ffff_first616-${STAMP}` // an IdP-shaped sub, minted internally like a real callback
    const seated = await acceptInvite(
      { db, fga: fgaClient }, { id: TENANT, plan: 'business' }, inv.token,
      { sub, email: `first-${STAMP}@e2e.test`, name: 'First Admin' },
      { subMintedInternally: true },
    )
    expect(seated, 'acceptance completes with no admin in the tenant').toBe(true)
    expect(await memberCount(), 'and exactly one person is now seated').toBe(1)

    const [row] = await admin<{ role: string }[]>`SELECT role FROM members WHERE tenant_id = ${TENANT}`
    expect(row?.role, 'seated with the role the invite carried').toBe('admin')
    cleanup.push({ user: `user:${sub}`, relation: 'admin', object: `tenant:${TENANT}` })
    // read the TUPLE, not a capability: `admin` is a tenant relation with no capability alias, and
    // asking `check()` for it throws rather than answering false (measured)
    const { tuples } = await fgaClient.read({ user: `user:${sub}`, object: `tenant:${TENANT}` })
    expect(
      (tuples ?? []).map((t) => t.key?.relation),
      'and the STORE agrees — a members row without the tuple is an admin who cannot do anything',
    ).toContain('admin')
  }, 180_000)

  it('the LOCAL (password) variant is refused at ISSUE time unless sign-in is on FIRST — an ORDER slice 1 must obey', async () => {
    // The finding that changes slice 1's shape: `createInvite({kind:'local'})` refuses while password
    // sign-in is off, so the command cannot mint the invite and then enable the door. The enablement
    // comes FIRST. (I assumed the refusal was at acceptance and measured otherwise.)
    const email = `local-${STAMP}@e2e.test`
    await admin`DELETE FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`
    await expect(
      createInvite(db, { tenantId: TENANT, plan: 'business', invitedBy: `operator:cli-${STAMP}`, email, role: 'admin', kind: 'local' }),
      'a password invite into a tenant with no password door is refused where the operator can still see it',
    ).rejects.toThrow(/password sign-in is off/)

    await admin`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${TENANT}, true)
                ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = true`
    const inv = await createInvite(db, {
      tenantId: TENANT, plan: 'business', invitedBy: `operator:cli-${STAMP}`, email, role: 'admin', kind: 'local',
    })
    const on = await acceptLocalInvite({ db, fga: fgaClient }, { id: TENANT, plan: 'business' }, inv.token, 'probe-616-passphrase')
    expect(on.ok, 'and works once the tenant offers it — the enablement slice 1 owns').toBe(true)
    if (on.ok) cleanup.push({ user: `user:${on.sub}`, relation: 'admin', object: `tenant:${TENANT}` })
  }, 180_000)

  it('the stance blocks only the PASSWORD invite, and only when a federated way in is real', async () => {
    //ruled the recovery command may step over the stance. This measures what there IS to step
    // over, and both halves narrow slice 1 further than the ADR assumed:
    //
    //   1. the guard is inside the `kind: 'local'` branch (`invites.ts:141-146`) — an OIDC invite is
    //      never refused by the stance, whatever it says;
    //   2. it bites only when a federated way in is REAL (ADR-210 §2 (d) lapse), so a tenant with the
    //      intent stored and no working connection is not blocked at all.
    //
    // The override therefore has one domain: a PASSWORD recovery into a tenant that has a working IdP
    // and nobody seated — a restore, not a fresh tenant.
    await admin`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled, sso_required) VALUES (${TENANT}, true, true)
                ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = true, sso_required = true`
    const mkLocal = (who: string) => createInvite(db, {
      tenantId: TENANT, plan: 'business', invitedBy: 'operator:x', email: `${who}-${STAMP}@e2e.test`, role: 'admin', kind: 'local',
    })
    try {
      const lapsed = await mkLocal('lapse')
      expect(lapsed.token, 'intent stored, nothing federated → the stance does not bite').toBeTruthy()

      const connId = randomUUID()
      await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, redirect_uri, enabled)
                  VALUES (${connId}, ${TENANT}, 'https://idp.e2e.test', 'probe616', 'https://x.e2e.test/cb', true)`
      try {
        await expect(mkLocal('sso'), 'with a working IdP the stance bites and the password invite is refused')
          .rejects.toMatchObject({ code: 'sso_required' })
        // …while the OIDC invite sails past the same stance — the guard never sees it
        const viaIdp = await createInvite(db, {
          tenantId: TENANT, plan: 'business', invitedBy: 'operator:x', email: `oidc-${STAMP}@e2e.test`, role: 'admin',
        })
        expect(viaIdp.token, 'an OIDC invite is not what the stance is guarding').toBeTruthy()
      } finally {
        await admin`DELETE FROM tenant_oidc WHERE id = ${connId}`
      }
    } finally {
      await admin`UPDATE tenant_login_prefs SET sso_required = false WHERE tenant_id = ${TENANT}`
    }
  }, 180_000)
})

// Integration — real Postgres, own tenant. #898 / ADR-251.
//
// ⚠️ WHY THIS FILE EXISTS. #836 narrowed ONE of three copies of the SSO floor: the precondition for
// turning the requirement ON now asks whether an exempt ADMINISTRATOR holds a password. The two
// guards that keep the floor standing afterwards — revoking an exemption, deleting a credential —
// kept their own queries, and neither read `role`. So the switch could be turned on because an exempt
// administrator held a password, and then that administrator's exemption or password removed because
// some exempt ORDINARY MEMBER held one. Two moves to the state the floor exists to prevent: during an
// IdP outage people can sign in, and nobody among them can fix anything.
//
// ⚠️ That is worse than before #836, when all three agreed loosely — the record now says the floor is
// held. Measured through the ROUTES against the real database, because the defect was in the queries
// the handlers ran, and a unit over the predicate would have been green the whole time.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { buildApp } from '../app.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const ADMIN_A = `sso898-admin-a-${STAMP}`   // exempt administrator with a password
const ADMIN_B = `sso898-admin-b-${STAMP}`   // a second one, added only where the test needs two
const PLAIN = `sso898-plain-${STAMP}`       // exempt ORDINARY member with a password — the decoy

let app: FastifyInstance
let pt: PrivateTenant

const seat = async (sub: string, role: 'admin' | 'member') => {
  await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${pt.id}, ${sub}, ${`${sub}@t.test`}, ${role})
              ON CONFLICT (tenant_id, sub) DO UPDATE SET role = ${role}, deactivated_at = NULL`
  await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
              VALUES (${pt.id}, ${sub}, ${`${sub}@t.test`}, 'x') ON CONFLICT DO NOTHING`
  await admin`INSERT INTO sso_exemptions (tenant_id, member_sub, created_by) VALUES (${pt.id}, ${sub}, 'dev-user')
              ON CONFLICT DO NOTHING`
  // #949: this file is about the SSO floor, not `memberHasAnotherWayIn` — give each member a way in
  // besides the credential the guard removes, or the per-member "last way in" check fires first and
  // the floor logic these cases exercise never runs.
  await admin`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
              VALUES (${pt.id}, ${`sso898-conn-${sub}`}, ${`sso898-ext-${sub}`}, ${sub})
              ON CONFLICT DO NOTHING`
}
const unseat = async (sub: string) => {
  await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${pt.id} AND member_sub = ${sub}`
  await admin`DELETE FROM local_credentials WHERE tenant_id = ${pt.id} AND member_sub = ${sub}`
  await admin`DELETE FROM members WHERE tenant_id = ${pt.id} AND sub = ${sub}`
}
const requireSso = (on: boolean) =>
  admin`INSERT INTO tenant_login_prefs (tenant_id, sso_required, local_login_enabled) VALUES (${pt.id}, ${on}, TRUE)
        ON CONFLICT (tenant_id) DO UPDATE SET sso_required = ${on}`

const revokeExemption = (sub: string) =>
  app.inject({ method: 'DELETE', url: `/admin/sso-exemptions/${sub}`, headers: pt.AUTH })
const deleteCredential = (sub: string) =>
  app.inject({ method: 'DELETE', url: `/members/${sub}/password-setup`, headers: pt.AUTH })

beforeAll(async () => {
  app = await buildApp()
  pt = await privateTenant(admin, 't898')
  await requireSso(true)
})

afterAll(async () => {
  for (const s of [ADMIN_A, ADMIN_B, PLAIN]) await unseat(s)
  await requireSso(false)
  await pt.dispose()
  await app.close()
  await admin.end()
})

describe('#898 the floor that lets the switch on is the floor that keeps it on', () => {
  it('the LAST exempt administrator is protected from both exits, though an exempt plain member holds a password', async () => {
    await seat(ADMIN_A, 'admin')
    await seat(PLAIN, 'member') // ⚠️ the decoy: the pre-#898 queries counted this one and allowed both
    try {
      const revoke = await revokeExemption(ADMIN_A)
      expect(revoke.statusCode, 'revoking the last exempt admin exemption is refused').toBe(409)
      expect(revoke.json().code ?? JSON.parse(revoke.body).code).toBe('sso_exemption_required')

      const del = await deleteCredential(ADMIN_A)
      expect(del.statusCode, 'and so is deleting that administrator password').toBe(409)
      expect(del.json().code).toBe('sso_exemption_required')

      // The state both refusals protect. ⚠️ Read on the admin handle and filtered by tenant BY HAND:
      // `members` is FORCE-RLS, so the runtime pool with no tenant context returns zero rows and this
      // count would have "passed" as 0 while proving nothing.
      const [{ n }] = await admin<{ n: number }[]>`
        SELECT count(*)::int AS n FROM members m
          JOIN local_credentials c ON c.member_sub = m.sub AND c.tenant_id = m.tenant_id
          JOIN sso_exemptions se ON se.member_sub = m.sub AND se.tenant_id = m.tenant_id
         WHERE m.tenant_id = ${pt.id} AND m.role = 'admin' AND m.deactivated_at IS NULL`
      expect(n, 'exactly one exempt administrator holds a key — that is why both were refused').toBe(1)
    } finally {
      await unseat(PLAIN)
      await unseat(ADMIN_A)
    }
  }, 60_000)

  it('with TWO exempt administrators both exits open — the guard is not simply refusing', async () => {
    // The over-refusal direction. A floor that never lets go is not a floor, and the ticket asks for
    // this half explicitly: a rule measured only by its refusals passes when written as `return 409`.
    await seat(ADMIN_A, 'admin')
    await seat(ADMIN_B, 'admin')
    try {
      expect((await revokeExemption(ADMIN_A)).statusCode, 'the second administrator carries the floor').toBe(204)
      await seat(ADMIN_A, 'admin') // put it back; now test the other exit
      expect((await deleteCredential(ADMIN_B)).statusCode, 'and the other exit is open too').toBe(200)
    } finally {
      await unseat(ADMIN_B)
      await unseat(ADMIN_A)
    }
  }, 60_000)

  it('with the requirement OFF neither guard bites', async () => {
    // The floor exists because the requirement is on. Refusing when it is off would strand a tenant
    // that never asked for SSO at all.
    await requireSso(false)
    await seat(ADMIN_A, 'admin')
    try {
      expect((await revokeExemption(ADMIN_A)).statusCode).toBe(204)
      await seat(ADMIN_A, 'admin')
      expect((await deleteCredential(ADMIN_A)).statusCode).toBe(200)
    } finally {
      await unseat(ADMIN_A)
      await requireSso(true)
    }
  }, 60_000)
})

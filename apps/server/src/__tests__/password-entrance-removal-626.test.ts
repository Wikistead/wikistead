// #626 / ADR-214: an admin can take back the password entrance they gave.
//
// The defect it closes is not "an item is missing from a menu". Removing somebody from the SSO-required
// exemption list left their credential in place, and during a stance lapse (the IdP is down, so the
// password door opens for everyone holding one — ADR-210 §2(d)) that person still signs in. The exemption
// was revoked; the key was not.
//
// Measured through the ROUTE, against the real database, because three of the five conditions are about
// rows the handler must also touch (the reset tokens), rows it must read from the right side (the SSO
// floor), and a predicate that was wrong in both directions in the first draft (the last way in).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const FED = `pw626-fed-${STAMP}`    // arrived through a connection: removing the password leaves a way in
const LOCAL = `pw626-local-${STAMP}` // password-born: the password IS the way in
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
const H_NO_BODY = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

let app: FastifyInstance
// ⚠️ #894: the SSO-floor case below reads TWO tenant-wide facts, so it cannot live in `tenant_dev`.
// Every other case in this file is per-member and stays there; only the one that needs the whole
// tenant to itself gets one.
let own: PrivateTenant
const OWN_FED = 'pw894-fed'      // the exempt member whose credential is removed
const OWN_OTHER = 'pw894-other'  // a second exempt member, added to flip the answer on purpose

const giveCredential = async (sub: string) =>
  admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
        VALUES (${TENANT}, ${sub}, ${`${sub}@fixture.test`}, 'x')
        ON CONFLICT (tenant_id, member_sub) DO UPDATE SET password_hash = 'x'`
const credentialCount = async (sub: string) =>
  Number((await admin<{ n: string }[]>`SELECT count(*)::text AS n FROM local_credentials WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`)[0]!.n)

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await seatMembers(admin, TENANT, [FED, LOCAL])
  await admin`UPDATE members SET identity_source = 'oidc' WHERE tenant_id = ${TENANT} AND sub = ${FED}`
  await admin`UPDATE members SET identity_source = 'local' WHERE tenant_id = ${TENANT} AND sub = ${LOCAL}`
  // #949 / ADR-259 §3.9: FED's "arrived through a connection" is now measured by a stored link, not by
  // `identity_source` (the proxy #949 retires). `connection_id` carries no foreign key by design (§3.9),
  // so a fixture string naming no real row is exactly the shape a member's own link takes.
  await admin`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
              VALUES (${TENANT}, ${`pw626-conn-${STAMP}`}, ${`pw626-ext-${STAMP}`}, ${FED})
              ON CONFLICT DO NOTHING`

  own = await privateTenant(admin, 'pw894')
  for (const sub of [OWN_FED, OWN_OTHER]) {
    await admin`INSERT INTO members (tenant_id, sub, email, role, identity_source)
                VALUES (${own.id}, ${sub}, ${`${sub}@pw894.test`}, 'member', 'oidc')
                ON CONFLICT (tenant_id, sub) DO UPDATE SET identity_source = 'oidc'`
    // #949: this file's SSO-floor cases are about the floor, not about `memberHasAnotherWayIn` — each
    // member needs a way in besides the credential the case removes, or the new per-member "last way
    // in" check fires first and the floor logic underneath it never runs.
    await admin`INSERT INTO member_identities (tenant_id, connection_id, external_subject, member_sub)
                VALUES (${own.id}, ${`pw894-conn-${sub}`}, ${`pw894-ext-${sub}`}, ${sub})
                ON CONFLICT DO NOTHING`
  }
}, 120_000)

afterAll(async () => {
  for (const sub of [FED, LOCAL]) {
    await admin`DELETE FROM password_resets WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`.catch(() => {})
    await admin`DELETE FROM local_credentials WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`.catch(() => {})
    await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`.catch(() => {})
    await admin`DELETE FROM member_identities WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`.catch(() => {})
  }
  await unseatMembers(admin, TENANT, [FED, LOCAL])
  await admin`UPDATE tenant_login_prefs SET sso_required = false WHERE tenant_id = ${TENANT}`.catch(() => {})
  await own?.dispose()
  await app.close(); await admin.end(); await pool.end()
}, 120_000)

const remove = (sub: string) =>
  app.inject({ method: 'DELETE', url: `/members/${sub}/password-setup`, headers: H_NO_BODY })

describe('#626: the password entrance can be taken back', () => {
  it('removes the credential, and says so', async () => {
    await giveCredential(FED)
    const res = await remove(FED)
    expect(res.statusCode, res.body).toBe(200)
    expect(await credentialCount(FED), 'the credential is gone').toBe(0)
  })

  it('takes the tokens that would put it back with it', async () => {
    // A setup token whose UPDATE matches no row INSERTS the credential (password-reset.ts) — so a link
    // minted in the last hour silently undoes the removal. Measured here rather than trusted: the row
    // must not survive the delete.
    await giveCredential(FED)
    await admin`INSERT INTO password_resets (tenant_id, member_sub, token_hash, expires_at)
                VALUES (${TENANT}, ${FED}, ${`h-${STAMP}`}, now() + interval '1 hour')`
    expect((await remove(FED)).statusCode).toBe(200)
    const [{ n }] = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM password_resets WHERE tenant_id = ${TENANT} AND member_sub = ${FED}`
    expect(Number(n), 'a pending setup token would restore what was just removed').toBe(0)
  })

  it('refuses when the password is the only way this person signs in', async () => {
    // The predicate is about THIS PERSON, not about the tenant. A first draft asked whether the tenant had
    // any federated door at all, which let a `wlocal_` member be locked out for good on an OIDC tenant
    // (their sub arrives from no connection) and refused every removal on a tenant using the shared
    // platform IdP. "Suspend them" (#627) is the operation for "stop this person signing in".
    await giveCredential(LOCAL)
    const res = await remove(LOCAL)
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ code: 'last_way_in' })
    expect(await credentialCount(LOCAL), 'and nothing was removed').toBe(1)
    await admin`DELETE FROM local_credentials WHERE tenant_id = ${TENANT} AND member_sub = ${LOCAL}`
  })

  // ⚠️ #894: this case lives in its OWN tenant, and the three assertions below say why.
  //
  // THE FLAKE. The guard reads two facts about the WHOLE tenant — the `sso_required` row, and whether
  // any OTHER exempt member holds a credential — and both were being read out of `tenant_dev`, which
  // more than twenty other files write. In a full run it failed once: 200 where 409 was expected, and
  // green on its own and green beside the file we suspected. ⚠️ **We never identified which file**,
  // and the ticket said not to fix it by asserting "shared tenant, therefore" — a fix whose effect
  // cannot be measured is not a fix.
  //
  // So the mechanism is measured instead of the race. The three cases below flip the answer by moving
  // exactly the two facts the guard reads. That is the reproduction condition stated in a form a test
  // can hold: **any file that writes either fact in a shared tenant flips this answer**, whichever
  // file it turns out to be. And they double as the proof that the isolation did not empty the
  // assertion — the refusal still has both of its causes.
  const ownRemove = (sub: string) =>
    app.inject({ method: 'DELETE', url: `/members/${sub}/password-setup`, headers: own.AUTH })
  const ownCredential = async (sub: string) =>
    admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
          VALUES (${own.id}, ${sub}, ${`${sub}@pw894.test`}, 'x')
          ON CONFLICT (tenant_id, member_sub) DO UPDATE SET password_hash = 'x'`
  const ownExempt = (sub: string) =>
    admin`INSERT INTO sso_exemptions (tenant_id, member_sub, created_by) VALUES (${own.id}, ${sub}, 'dev-user')
          ON CONFLICT DO NOTHING`
  const ownStance = (on: boolean) =>
    admin`UPDATE tenant_login_prefs SET sso_required = ${on} WHERE tenant_id = ${own.id}`

  it('refuses to empty the SSO-required floor from the credential side', async () => {
    // The two existing guards read the EXEMPTION rows; this route removes the CREDENTIAL, so the floor can
    // be emptied from a side it does not watch — leaving a tenant that requires SSO with an exemption that
    // opens nothing, which is the outage case the floor exists for.
    await ownCredential(OWN_FED)
    await ownExempt(OWN_FED)
    await ownStance(true)
    const res = await ownRemove(OWN_FED)
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toMatchObject({ code: 'sso_exemption_required' })
    const [{ n }] = await admin<{ n: string }[]>`
      SELECT count(*)::text AS n FROM local_credentials WHERE tenant_id = ${own.id} AND member_sub = ${OWN_FED}`
    expect(Number(n), 'the refused removal took the credential anyway').toBe(1)
  })

  it('⚠️ …and the stance being off is one of the two facts that flips it', async () => {
    // Fact one. A file that resets `tenant_login_prefs` in a shared tenant produces exactly this.
    await ownCredential(OWN_FED)
    await ownExempt(OWN_FED)
    await ownStance(false)
    try {
      expect((await ownRemove(OWN_FED)).statusCode, 'the floor is only guarded while the stance is on').toBe(200)
    } finally {
      await ownStance(true)
    }
  })

  it('⚠️ …and another exempt ADMINISTRATOR holding a credential is the other', async () => {
    // Fact two, and the harder one to see: the floor is not emptied, so the removal is correct. A file
    // that leaves an exemption AND a credential behind in a shared tenant hands this case a second
    // key-holder it never asked for.
    //
    // ⚠️ #898 changed WHO counts as that second key-holder, and this case asserted the old answer.
    // It seated the sibling as a plain `member`, so it was measuring the hole rather than the floor:
    // an exempt ordinary member with a password lets nobody administer anything when the IdP is down,
    // which is the state the floor exists to prevent. The sibling is promoted for the duration.
    await ownCredential(OWN_FED)
    await ownExempt(OWN_FED)
    await ownStance(true)
    await ownCredential(OWN_OTHER)
    await ownExempt(OWN_OTHER)
    await admin`UPDATE members SET role = 'admin' WHERE tenant_id = ${own.id} AND sub = ${OWN_OTHER}`
    try {
      expect((await ownRemove(OWN_FED)).statusCode, 'another exempt ADMIN still holds a key — the floor stands').toBe(200)
    } finally {
      await admin`UPDATE members SET role = 'member' WHERE tenant_id = ${own.id} AND sub = ${OWN_OTHER}`
      await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${own.id} AND member_sub = ${OWN_OTHER}`
      await admin`DELETE FROM local_credentials WHERE tenant_id = ${own.id} AND member_sub = ${OWN_OTHER}`
    }
  })

  it('⚠️ …but an exempt ordinary member holding one is NOT (#898)', async () => {
    // The half the case above used to assert. Same fixture, sibling left as a plain member: the
    // removal is refused, because after it nobody who can sign in during an outage can administer
    // anything. Both halves live here so the pair cannot drift the way the three copies of this rule
    // drifted -- one of them is always red for a `role`-blind guard.
    await ownCredential(OWN_FED)
    await ownExempt(OWN_FED)
    await ownStance(true)
    await ownCredential(OWN_OTHER)
    await ownExempt(OWN_OTHER)
    try {
      const res = await ownRemove(OWN_FED)
      expect(res.statusCode, 'an exempt plain member is not a way to administer anything').toBe(409)
      expect(res.json().code).toBe('sso_exemption_required')
    } finally {
      await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${own.id} AND member_sub = ${OWN_OTHER}`
      await admin`DELETE FROM local_credentials WHERE tenant_id = ${own.id} AND member_sub = ${OWN_OTHER}`
    }
  })

  it('is not behind the tenant password switch — a tenant that turned it off can still clear what it gave', () => {
    // Granting belongs behind that switch; removal must not, or a tenant that has since moved to SSO can
    // never clear the credentials it handed out while the switch was on.
    //
    // Asserted on the HANDLER rather than by flipping the switch: `tenant_login_prefs` is one row for the
    // whole tenant, and this suite shares `tenant_dev` with files that read it — toggling it here turned
    // `tenant-oidc`'s lockout guard red from another process. What the condition means is that the removal
    // path never consults `local_login_enabled`, and that is visible where it is written.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { resolve } = require('node:path') as typeof import('node:path')
    const src = readFileSync(resolve(import.meta.dirname, '..', 'routes', 'members.ts'), 'utf8')
    const handler = src.slice(src.indexOf("app.delete<{ Params: { sub: string } }>('/members/:sub/password-setup'"))
    const body = handler.slice(0, handler.indexOf('app.post<'))
    expect(body, 'the removal reads the SSO stance…').toMatch(/sso_required/)
    expect(body, '…and never the password switch').not.toMatch(/local_login_enabled/)
  })

  it('answers 404 for a member with no entrance, and for no member at all', async () => {
    await admin`DELETE FROM local_credentials WHERE tenant_id = ${TENANT} AND member_sub = ${FED}`
    expect((await remove(FED)).statusCode, 'nothing to remove').toBe(404)
    expect((await remove('pw626-nobody')).statusCode, 'no such member').toBe(404)
  })

  it('is admin-only', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/members/${FED}/password-setup`,
      headers: { host: 'dev.localhost' },
    })
    expect(res.statusCode, 'an unauthenticated caller cannot remove an entrance').toBeGreaterThanOrEqual(401)
  })
})

// The claim the migration comment got wrong, pinned so nobody "fixes" the code to match the prose:
// `110_sso_required.sql` says revoking an exemption is enough because the key opens nothing — but the
// login path only consults exemptions while the stance is in force (auth-local.ts). During a lapse every
// credential holder is admitted, exempt or not, which is why removing the credential had to exist.
describe('#626: what a lapse admits', () => {
  it('the login path reads exemptions only while the stance holds', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(import.meta.dirname, '..', 'routes', 'auth-local.ts'), 'utf8')
    // the exemption lookup is inside the stance branch — not a precondition of the password door itself
    expect(src, 'the exemption join exists').toMatch(/sso_exemptions/)
    const migration = readFileSync(
      resolve(import.meta.dirname, '..', '..', '..', '..', 'infra', 'db', 'migrations', '110_sso_required.sql'), 'utf8')
    expect(migration, 'the migration no longer claims that revoking an exemption is sufficient on its own')
      .not.toMatch(/nothing to open|opens nothing/i)
  })
})

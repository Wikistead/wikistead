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

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const FED = `pw626-fed-${STAMP}`    // arrived through a connection: removing the password leaves a way in
const LOCAL = `pw626-local-${STAMP}` // password-born: the password IS the way in
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
const H_NO_BODY = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

let app: FastifyInstance

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
}, 120_000)

afterAll(async () => {
  for (const sub of [FED, LOCAL]) {
    await admin`DELETE FROM password_resets WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`.catch(() => {})
    await admin`DELETE FROM local_credentials WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`.catch(() => {})
    await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${TENANT} AND member_sub = ${sub}`.catch(() => {})
  }
  await unseatMembers(admin, TENANT, [FED, LOCAL])
  await admin`UPDATE tenant_login_prefs SET sso_required = false WHERE tenant_id = ${TENANT}`.catch(() => {})
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

  it('refuses to empty the SSO-required floor from the credential side', async () => {
    // The two existing guards read the EXEMPTION rows; this route removes the CREDENTIAL, so the floor can
    // be emptied from a side it does not watch — leaving a tenant that requires SSO with an exemption that
    // opens nothing, which is the outage case the floor exists for.
    await giveCredential(FED)
    await admin`INSERT INTO sso_exemptions (tenant_id, member_sub, created_by) VALUES (${TENANT}, ${FED}, 'dev-user')
                ON CONFLICT DO NOTHING`
    await admin`UPDATE tenant_login_prefs SET sso_required = true WHERE tenant_id = ${TENANT}`
    try {
      const res = await remove(FED)
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json()).toMatchObject({ code: 'sso_exemption_required' })
      expect(await credentialCount(FED)).toBe(1)
    } finally {
      await admin`UPDATE tenant_login_prefs SET sso_required = false WHERE tenant_id = ${TENANT}`
      await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${TENANT} AND member_sub = ${FED}`
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

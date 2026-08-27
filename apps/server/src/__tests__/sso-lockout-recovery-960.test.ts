// #858 / #960, ADR-259 §3.5a: the four-step recovery line for an SSO-required tenant where a stranded
// member has no working entrance — walked end to end, through the real routes, rather than trusted from
// the ADR's prose. Step 1 (an operator creates a rescue admin who can actually sign in) is #616's own,
// thoroughly-walked claim; this file starts from its result and walks the three steps ADR-259 adds:
// exempt the rescue admin, exempt the stranded member, mint and complete their password entrance — and
// then proves the member can sign back in, though the stance is still biting for everybody else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { createLocalAdmin } from '../scripts/local-admin.js'
import { acceptLocalInvite } from '../auth/invites.js'
import { establishMemberSession, SESSION_COOKIE } from '../auth/session.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SLUG = `t960resc-${STAMP}`
const HOST = `${SLUG}.localhost`
const H = { host: HOST, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }

let app: FastifyInstance
let tenant: PrivateTenant
let db: TenantDb

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = await privateTenant(admin, SLUG)
  db = await acquireTenantDb({ id: tenant.id, slug: tenant.slug, plan: 'business', isolation: 'logical' } as never)
  // The lockout this line exists for: SSO required and BITING — which needs a federated door to make
  // the requirement mean anything — and (unlike `dev-user`, who this file never signs in as) nobody
  // holds an exemption yet.
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, redirect_uri, enabled)
              VALUES (${`t960resc-conn-${STAMP}`}, ${tenant.id}, 'https://idp.t960resc.test', 'c', ${`https://${HOST}/auth/callback`}, TRUE)`
  await admin`INSERT INTO tenant_login_prefs (tenant_id, sso_required, local_login_enabled)
              VALUES (${tenant.id}, TRUE, TRUE)
              ON CONFLICT (tenant_id) DO UPDATE SET sso_required = TRUE, local_login_enabled = TRUE`
}, 60_000)

afterAll(async () => {
  await db?.release()
  await tenant?.dispose()
  await app.close(); await admin.end(); await pool.end()
}, 60_000)

// No content-type: several of the calls below carry no body, and Fastify's JSON parser refuses an
// empty one when a content-type it owns is present.
const sessionHeaders = (sid: string) => ({ host: HOST, 'sec-fetch-site': 'same-origin', cookie: `${SESSION_COOKIE}=${sid}` })

describe('#960 / ADR-259 §3.5a: the recovery line, walked', () => {
  it('rescue admin → self-exemption → stranded member exemption → minted password → the member signs back in', async () => {
    // A member left with no way in at all — the state a connection's deletion (this ticket) or a
    // connection re-key (#929) can both produce.
    const strandedSub = `t960resc-stranded-${STAMP}`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${strandedSub}, ${`${strandedSub}@t960resc.test`}, 'member')`
    // The DB row alone is not membership: `establishMemberSession` asks OpenFGA, and a fixture that
    // skips this tuple measures a login that could never have worked in the first place.
    await writeTuples(fgaClient, [{ user: `user:${strandedSub}`, relation: 'member', object: `tenant:${tenant.id}` }])

    // Step 1 (#616's own claim, not re-walked here): an operator creates an administrator at a NEW
    // address, on the EXISTING tenant (no --create — this is recovery, not first-boot).
    const result = await createLocalAdmin(admin, { slug: SLUG, email: `rescue-${STAMP}@t960resc.test`, origin: `https://${HOST}` })
    expect(result.steppedOverStance, 'the operator override is what gets the invite past the biting stance').toBe(true)
    const token = new URL(result.inviteUrl).searchParams.get('token')!
    const tenantRef = { id: tenant.id, plan: 'business' }
    const outcome = await acceptLocalInvite({ db, fga: fgaClient }, tenantRef, token, 'rescue-admin-passphrase!')
    // Accepting through `acceptLocalInvite` alone is #616's claim; the route layers on ONE more thing
    // this file needs — a session that survives the SAME stance the invite just stepped over — so it is
    // taken here explicitly rather than assumed.
    expect(outcome.ok, 'the operator invite is accepted').toBe(true)
    if (!outcome.ok) return
    const rescueSub = outcome.sub
    const rescueSid = await establishMemberSession(
      { db, fga: fgaClient, valkey: app.valkey, searchDriver: app.searchDriver },
      tenantRef, { sub: rescueSub },
      { localIdentity: true, door: outcome.operatorIssued ? 'operator' : 'local' },
    )
    const rescueHeaders = sessionHeaders(rescueSid)

    try {
      // Step 2, named in the ADR: "the first exemption an operator writes is their own administrator's"
      // — without it, this session is the rescue's only route back once it ends.
      const exemptSelf = await app.inject({ method: 'PUT', url: `/admin/sso-exemptions/${rescueSub}`, headers: rescueHeaders })
      expect(exemptSelf.statusCode, exemptSelf.body).toBe(204)

      // Step 3: exempt the stranded member.
      const exemptMember = await app.inject({ method: 'PUT', url: `/admin/sso-exemptions/${strandedSub}`, headers: rescueHeaders })
      expect(exemptMember.statusCode, exemptMember.body).toBe(204)

      // Step 4: mint the stranded member a password entrance — dead on arrival while the stance bites
      // for a NON-exempt member (ADR §3.5a), which is exactly why step 3 has to land first.
      const minted = await app.inject({ method: 'POST', url: `/members/${strandedSub}/password-setup`, headers: rescueHeaders })
      expect(minted.statusCode, minted.body).toBe(201)
      const setupToken = new URL(minted.json().setupUrl).searchParams.get('token')!
      const NEW_PASSWORD = 'stranded-member-new-passphrase!'
      const completed = await app.inject({
        method: 'POST', url: '/auth/local/reset', headers: H,
        payload: { token: setupToken, password: NEW_PASSWORD },
      })
      expect(completed.statusCode, completed.body).toBe(204)

      // The proof: the stranded member signs in with their new password while the stance is STILL
      // biting for the rest of the tenant — the exemption from step 3, not a stance change, is what
      // lets them through.
      const [cred] = await admin<{ identifier: string }[]>`
        SELECT identifier FROM local_credentials WHERE tenant_id = ${tenant.id} AND member_sub = ${strandedSub}`
      const signedIn = await app.inject({
        method: 'POST', url: '/auth/local/login', headers: H,
        payload: { identifier: cred!.identifier, password: NEW_PASSWORD },
      })
      expect(signedIn.statusCode, signedIn.body).toBe(200)
      expect(signedIn.cookies.some((c) => c.name === SESSION_COOKIE), 'the stranded member has a working session again').toBe(true)

      const [stance] = await admin<{ sso_required: boolean }[]>`SELECT sso_required FROM tenant_login_prefs WHERE tenant_id = ${tenant.id}`
      expect(stance!.sso_required, 'this was never a stance change — it stayed on the whole time').toBe(true)
    } finally {
      // Both the stranded member's own tuple (written here) and the rescue admin's (written by
      // `enrolUnderSeatCap` inside `acceptLocalInvite`) — `privateTenant.dispose()` only cleans the row
      // it seeded (`dev-user`), and an orphan tuple naming a deleted tenant is exactly #829's shape.
      await deleteTuples(fgaClient, [
        { user: `user:${strandedSub}`, relation: 'member', object: `tenant:${tenant.id}` },
        { user: `user:${rescueSub}`, relation: 'member', object: `tenant:${tenant.id}` },
        { user: `user:${rescueSub}`, relation: 'admin', object: `tenant:${tenant.id}` },
      ]).catch(() => {})
      await admin`DELETE FROM local_credentials WHERE tenant_id = ${tenant.id}`.catch(() => {})
      await admin`DELETE FROM sso_exemptions WHERE tenant_id = ${tenant.id}`.catch(() => {})
      await admin`DELETE FROM invites WHERE tenant_id = ${tenant.id}`.catch(() => {})
      await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub IN (${strandedSub}, ${rescueSub})`.catch(() => {})
    }
  }, 30_000)
})

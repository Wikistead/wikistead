// #1074 (ruled 2026-09-03), amending #606: the password-setup refusal draws its line between facts
// about the PERSON, which stay uniform, and facts about the DEPLOYMENT, which are named.
//
// #606 had ruled all of them uniform, on existence-hiding grounds. That was right for the person-side
// causes and wrong for the deployment-side one: an unset address is the same for every member of the
// deployment, so naming it discloses zero bits about the one the admin picked — while hiding it turns
// an operator's settings mistake into an unreadable mystery about a colleague. The invite door one
// screen over has always named it, so #606's line was never uniform in practice.
//
// Measured HERE, at the HTTP response, not in the toast: the UI is convenience and the server is the
// fortress, so what the product actually discloses is the status, the code and the body.
//
// THE ORDERING IS THE POINT. Run the person check first and an address-less deployment answers
// `deployment_has_no_address` to the members who could otherwise be minted and the uniform sentence to
// the rest — and the uniform sentence, appearing for some people and not others, is exactly the
// disclosure uniformity exists to prevent. The first test below is that pin: it goes red the moment
// the two checks trade places.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
// no content-type: this POST carries no body, and Fastify refuses an empty one when json is declared
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

// One member per PERSON-side refusal cause, plus one with nothing wrong at all.
const OK = `pf1074-ok-${STAMP}`            // has an address of their own, no collision
const NO_EMAIL = `pf1074-noaddr-${STAMP}`  // person-side: no sign-in name to bind to
const CLASHED = `pf1074-clash-${STAMP}`    // person-side: the address is somebody ELSE's credential
const OTHER = `pf1074-other-${STAMP}`      // the somebody else
const emailOf = (sub: string) => `${sub}@e2e.test`

let app: FastifyInstance
let db: TenantDb
let savedBaseUrl: string | undefined

const setLocalLogin = (on: boolean) =>
  db.sql`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${TENANT}, ${on})
         ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = ${on}`

const setup = (sub: string) => app.inject({ method: 'POST', url: `/members/${sub}/password-setup`, headers: H })

/** The deployment has no address at all: no verified custom domain, and nothing to compose one from. */
const withNoAddress = async <T>(run: () => Promise<T>): Promise<T> => {
  delete process.env.WKS_PUBLIC_BASE_URL
  try { return await run() } finally {
    if (savedBaseUrl === undefined) delete process.env.WKS_PUBLIC_BASE_URL
    else process.env.WKS_PUBLIC_BASE_URL = savedBaseUrl
  }
}

const resetTokens = async (sub: string): Promise<number> =>
  Number((await admin<{ n: string }[]>`SELECT count(*) AS n FROM password_resets WHERE member_sub = ${sub}`)[0]!.n)

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  savedBaseUrl = process.env.WKS_PUBLIC_BASE_URL
  await setLocalLogin(true)
  for (const [sub, email] of [[OK, emailOf(OK)], [NO_EMAIL, null], [CLASHED, emailOf(CLASHED)], [OTHER, emailOf(CLASHED)]] as const) {
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${TENANT}, ${sub}, ${email}, 'member')
                ON CONFLICT (tenant_id, sub) DO NOTHING`
  }
  // OTHER already owns CLASHED's address as a sign-in name, so CLASHED cannot bind to it.
  await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
              VALUES (${TENANT}, ${OTHER}, ${emailOf(CLASHED)}, 'x') ON CONFLICT DO NOTHING`
  // The verified-domain arm has to be empty too, or WKS_PUBLIC_BASE_URL is not the only address.
  await admin`DELETE FROM custom_domains WHERE tenant_id = ${TENANT}`
}, 180_000)

afterAll(async () => {
  if (savedBaseUrl !== undefined) process.env.WKS_PUBLIC_BASE_URL = savedBaseUrl
  await setLocalLogin(false).catch(() => {})
  for (const sub of [OK, NO_EMAIL, CLASHED, OTHER]) {
    await admin`DELETE FROM local_credentials WHERE member_sub = ${sub}`.catch(() => {})
    await admin`DELETE FROM password_resets WHERE member_sub = ${sub}`.catch(() => {})
    await admin`DELETE FROM members WHERE sub = ${sub}`.catch(() => {})
  }
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 60_000)

describe('#1074 condition 1: the deployment fact short-circuits before any person check', () => {
  it('an address-less deployment answers the SAME thing to a mintable member and to one that is not', async () => {
    const [mintable, personRefused] = await withNoAddress(async () => [await setup(OK), await setup(NO_EMAIL)] as const)

    // The claim is the ABSENCE of a difference — that is what carries the disclosure. Both halves are
    // asserted, so a run where one of them silently became a 404 or a 500 cannot read as agreement.
    expect(mintable.statusCode, 'the mintable member').toBe(400)
    expect(personRefused.statusCode, 'the member with a person-side reason').toBe(400)
    expect(mintable.json().code).toBe('deployment_has_no_address')
    expect(
      personRefused.json().code,
      'a member the mint would refuse must NOT be told so while the deployment has no address — that ' +
        'difference is itself the disclosure',
    ).toBe('deployment_has_no_address')
    expect(personRefused.body, 'byte-identical, not merely the same code').toBe(mintable.body)
  })

  it('a member the deployment cannot reach is left with no reset token behind', async () => {
    const before = await resetTokens(OK)
    await withNoAddress(() => setup(OK))
    expect(
      await resetTokens(OK),
      'the old order minted a token and then threw the response away, leaving a live one for an errand that never ran',
    ).toBe(before)
  })
})

describe('#1074 condition 2: measured at the response, uniform side stays uniform', () => {
  it('the person-side causes are one answer: same status, same code, same body', async () => {
    // (a) the tenant has password sign-in off — a CONFIGURATION fact, which #1074's line puts on the
    // nameable side. It stays uniform HERE because the local-invite door already names it in its own
    // words, and reconciling the two doors is its own ticket rather than a change smuggled in here.
    await setLocalLogin(false)
    const loginOff = await setup(OK)
    await setLocalLogin(true)
    // (b) the member has no address of their own, and (c) their address is somebody else's sign-in name
    const noOwnAddress = await setup(NO_EMAIL)
    const collision = await setup(CLASHED)

    for (const [name, res] of [['sign-in off', loginOff], ['no address of their own', noOwnAddress], ['identifier collision', collision]] as const) {
      expect(res.statusCode, `${name}: status`).toBe(400)
      expect(res.json().code, `${name}: code`).toBe('password_setup_unavailable')
    }
    expect(noOwnAddress.body, 'no-address and sign-in-off are indistinguishable').toBe(loginOff.body)
    expect(collision.body, 'a collision and sign-in-off are indistinguishable').toBe(loginOff.body)
  })

  it('the deployment fact is a DIFFERENT code from the uniform one', async () => {
    const named = await withNoAddress(() => setup(OK))
    const uniform = await setup(NO_EMAIL)
    expect(named.json().code).toBe('deployment_has_no_address')
    expect(uniform.json().code).toBe('password_setup_unavailable')
    expect(named.json().code, 'the split is the whole ruling — one code cannot serve both').not.toBe(uniform.json().code)
  })
})

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
//
// #1075 (condition 3's split-off, same day): a second nameable fact reached this door — "password
// sign-in is off for this tenant" is a SETTING too, and the local-invite door already names it. It used
// to fall into the uniform bucket by accident of never having been examined; the tests near the bottom
// of this file pin it as its own code, checked before everything else including #1074's own address
// check, for the identical ordering reason.
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
    // #1075 split "sign-in off" out of this set (see the describe block below) — the two REMAINING
    // causes are genuine person facts: (a) the member has no address of their own, and (b) their
    // address is somebody else's sign-in name.
    const noOwnAddress = await setup(NO_EMAIL)
    const collision = await setup(CLASHED)

    for (const [name, res] of [['no address of their own', noOwnAddress], ['identifier collision', collision]] as const) {
      expect(res.statusCode, `${name}: status`).toBe(400)
      expect(res.json().code, `${name}: code`).toBe('password_setup_unavailable')
    }
    expect(collision.body, 'a collision and no-own-address are indistinguishable').toBe(noOwnAddress.body)
  })

  it('the deployment fact is a DIFFERENT code from the uniform one', async () => {
    const named = await withNoAddress(() => setup(OK))
    const uniform = await setup(NO_EMAIL)
    expect(named.json().code).toBe('deployment_has_no_address')
    expect(uniform.json().code).toBe('password_setup_unavailable')
    expect(named.json().code, 'the split is the whole ruling — one code cannot serve both').not.toBe(uniform.json().code)
  })
})

// #1075 (#1074's line, condition 3's split-off): "password sign-in is off for this tenant" is a
// SETTING, not a person fact — every member of the tenant hits it identically, and the local-invite
// door one screen over has always named it. It used to fall into the uniform `password_setup_unavailable`
// bucket above (see #1074 condition 2's first test, now trimmed); this door now names it too, with the
// same code the invite door uses (`local_login_disabled`), and checks it FIRST — before #1074's own
// deployment-address check — for the same ordering reason: if it ran after either the address check or
// a person check, a member some OTHER cause would refuse could be told the tenant setting instead,
// and that split would itself be the disclosure the uniform sentence exists to prevent.
describe('#1075: the tenant setting is named, and named before every other check', () => {
  it('sign-in off gets its own code, distinct from both the uniform person answer and the deployment one', async () => {
    await setLocalLogin(false)
    try {
      const loginOff = await setup(OK)
      expect(loginOff.statusCode).toBe(400)
      expect(loginOff.json().code, 'the same code the local-invite door uses for the same fact').toBe('local_login_disabled')
      expect(loginOff.json().code).not.toBe('password_setup_unavailable')
      expect(loginOff.json().code).not.toBe('deployment_has_no_address')
    } finally {
      await setLocalLogin(true)
    }
  })

  it('runs before the deployment-address check: a mintable member and an address-less-deployment member get the SAME answer while sign-in is off', async () => {
    await setLocalLogin(false)
    try {
      const [mintable, addressLess] = await withNoAddress(async () => [await setup(OK), await setup(OK)] as const)
      expect(mintable.json().code).toBe('local_login_disabled')
      expect(addressLess.json().code, 'the tenant-setting check runs first, so the missing address never gets asked').toBe('local_login_disabled')
      expect(addressLess.body).toBe(mintable.body)
    } finally {
      await setLocalLogin(true)
    }
  })

  it('runs before the person checks too: sign-in off answers the same for a mintable member and a person-refused one', async () => {
    await setLocalLogin(false)
    try {
      const mintable = await setup(OK)
      const personRefused = await setup(NO_EMAIL)
      expect(mintable.json().code).toBe('local_login_disabled')
      expect(personRefused.json().code, 'a member the mint would refuse must not be told so while sign-in is off').toBe('local_login_disabled')
      expect(personRefused.body).toBe(mintable.body)
    } finally {
      await setLocalLogin(true)
    }
  })
})

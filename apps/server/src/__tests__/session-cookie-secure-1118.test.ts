// #1118 (both #1091 reviews' "worth a follow-up pin" note, confirmed as a real gap by the 2026-09-05
// review probe): the #1091 pin in auth-session.test.ts calls `sessionCookieOptions({headers,
// protocol})` as a plain FUNCTION — it cannot catch a call SITE that drops an argument (the EE SAML
// route did exactly that on #1091's first landing,, and stale dist let typecheck miss it too).
//
// This pin reads the real `Set-Cookie` header off a real sign-in through `app.inject`, the same way
// auth-local-login-568.test.ts already does, over both plain HTTP and `x-forwarded-proto: https`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { hashPassword } from '../auth/password-hash.js'
import { enrolUnderSeatCap } from '../auth/invites.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const SLUG = 'cksec1118'
const TENANT = `tenant_${SLUG}`
const HOST = `${SLUG}.localhost`
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const PASSWORD = 'a-perfectly-fine-passphrase-1118'
const SUB = `wlocal_${SLUG}`
const IDENTIFIER = `${SLUG}@e2e.test`

let app: FastifyInstance
let db: TenantDb
let pt: PrivateTenant

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  pt = await privateTenant(adminPool, SLUG, { plan: 'business' })
  db = await acquireTenantDb(asTenant(TENANT))
  await db.tx((tx) => enrolUnderSeatCap(tx, fgaClient, { id: TENANT, plan: 'business' }, { sub: SUB, email: IDENTIFIER }, 'member', 'invite', 'local'))
  await db.sql`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
               VALUES (${TENANT}, ${SUB}, ${IDENTIFIER}, ${await hashPassword(PASSWORD)})`
  await db.sql`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${TENANT}, true)
               ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = true`
}, 120_000)

afterAll(async () => {
  await adminPool`DELETE FROM local_credentials WHERE member_sub = ${SUB}`.catch(() => {})
  await adminPool`DELETE FROM members WHERE sub = ${SUB}`.catch(() => {})
  await deleteTuples(fgaClient, [{ user: `user:${SUB}`, relation: 'member', object: `tenant:${TENANT}` }]).catch(() => {})
  await pt.dispose().catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

const login = (extraHeaders: Record<string, string> = {}) => app.inject({
  method: 'POST', url: '/auth/local/login',
  headers: { host: HOST, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...extraHeaders },
  payload: { identifier: IDENTIFIER, password: PASSWORD },
})

describe('#1118: the real Set-Cookie response, not just the sessionCookieOptions() function', () => {
  it('plain HTTP gets no Secure attribute; x-forwarded-proto: https does', async () => {
    const plain = await login()
    expect(plain.statusCode, plain.body).toBe(200)
    const plainCookie = plain.cookies.find((c) => c.name === 'wks_sess')
    expect(plainCookie, 'a session cookie was set').toBeTruthy()
    expect(plainCookie!.secure, 'plain HTTP must not set Secure — the browser would silently drop it').not.toBe(true)

    const https = await login({ 'x-forwarded-proto': 'https' })
    expect(https.statusCode, https.body).toBe(200)
    const httpsCookie = https.cookies.find((c) => c.name === 'wks_sess')
    expect(httpsCookie, 'a session cookie was set').toBeTruthy()
    expect(httpsCookie!.secure, 'behind a TLS-terminating proxy, Secure must be set').toBe(true)
  }, 120_000)
})

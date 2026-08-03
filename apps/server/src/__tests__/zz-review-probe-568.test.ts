// TEMPORARY review probe (#568). Deleted after the run — not a product test.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { hashPassword } from '../auth/password-hash.js'
import { enrolUnderSeatCap } from '../auth/invites.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const PASSWORD = 'a-perfectly-fine-passphrase'
const H = { host: 'dev.localhost', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
let app: FastifyInstance
let db: TenantDb
const subs: string[] = []

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb({ id: TENANT, slug: TENANT, plan: 'business', isolation: 'logical' } as Tenant)
  await db.sql`INSERT INTO tenant_login_prefs (tenant_id, local_login_enabled) VALUES (${TENANT}, true)
               ON CONFLICT (tenant_id) DO UPDATE SET local_login_enabled = true`
}, 120_000)
afterAll(async () => {
  await db.sql`UPDATE tenant_login_prefs SET local_login_enabled = false WHERE tenant_id = ${TENANT}`.catch(() => {})
  for (const s of subs) {
    await adminPool`DELETE FROM local_credentials WHERE member_sub = ${s}`.catch(() => {})
    await adminPool`DELETE FROM members WHERE sub = ${s}`.catch(() => {})
  }
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('probe: deactivated local member', () => {
  it('answers what?', async () => {
    const sub = `wlocal_probe-${STAMP}`; subs.push(sub)
    const identifier = `probe-${STAMP}@e2e.test`
    await db.tx((tx) => enrolUnderSeatCap(tx, fgaClient, { id: TENANT, plan: 'business' }, { sub, email: identifier }, 'member', 'invite', 'local'))
    await db.sql`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
                 VALUES (${TENANT}, ${sub}, ${identifier}, ${await hashPassword(PASSWORD)})`
    // freeze the member (#131)
    await db.sql`UPDATE members SET deactivated_at = now() WHERE sub = ${sub}`
    const right = await app.inject({ method: 'POST', url: '/auth/local/login', headers: H, payload: { identifier, password: PASSWORD } })
    const wrong = await app.inject({ method: 'POST', url: '/auth/local/login', headers: H, payload: { identifier, password: 'nope-nope-nope' } })
    console.log('PROBE deactivated+correct  =>', right.statusCode, right.body)
    console.log('PROBE deactivated+wrong    =>', wrong.statusCode, wrong.body)
    expect([right.statusCode, wrong.statusCode]).toEqual([401, 401])
  }, 180_000)
})

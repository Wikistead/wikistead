// #1107 / ADR-280 §2 (rev5/rev6): `memberIdentitiesEnabled` on GET /admin/surfaces tracks the EE
// composition marker, not a hardcoded value — the SAME technique #723's ce-scim-surface-723.test.ts
// uses, but through the HTTP route (`app.inject`), because this field is computed in the
// `/admin/surfaces` handler itself, not in `readableAdminSurfaces()` (rev5's own precision note).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { registerMemberIdentities, resetMemberIdentitiesRegistration } from '../member-identities-sink.js'
import { pool } from '../db/pool.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { ensureMembers, memberTuples } from './helpers/membership.js'
import { seatMembers, unseatMembers } from './helpers/seat-members.js'

const HOST = 'dev.localhost'
const TENANT = 'tenant_dev'
const PLAIN = `mi1107-plain-${Date.now().toString(36)}`
let app: FastifyInstance
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6381')

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  // #1165: the field is `marker AND isTenantAdmin` — a fixture that only ever asks as dev-user (an
  // admin) can never see the admin half do anything, because it never varies. This member is seated
  // and given tenant membership but no admin/role grant, so the two inputs are exercised separately.
  await seatMembers(admin, TENANT, [PLAIN])
  await ensureMembers(TENANT, [PLAIN])
}, 60_000)

afterEach(() => resetMemberIdentitiesRegistration())
afterAll(async () => {
  await deleteTuples(fgaClient, memberTuples(TENANT, [PLAIN])).catch(() => {})
  await unseatMembers(admin, TENANT, [PLAIN])
  await app.close(); await admin.end(); await valkey.quit(); await pool.end()
}, 60_000)

describe('#1107: memberIdentitiesEnabled tracks the composition marker, not a hardcoded value', () => {
  it('CE default: not registered, a tenant admin sees memberIdentitiesEnabled: false', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/surfaces', headers: { host: HOST, authorization: 'Bearer dev-token' } })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as { memberIdentitiesEnabled: boolean }).memberIdentitiesEnabled).toBe(false)
  }, 60_000)

  it('registered: the SAME injected request now returns true', async () => {
    registerMemberIdentities()
    const res = await app.inject({ method: 'GET', url: '/admin/surfaces', headers: { host: HOST, authorization: 'Bearer dev-token' } })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as { memberIdentitiesEnabled: boolean }).memberIdentitiesEnabled).toBe(true)
  }, 60_000)

  // #1165 (#1107 ③ review finding): the existing two cases above vary only the marker,
  // always as dev-user — an admin. Neither one measures the OTHER half of `marker && isTenantAdmin`,
  // so a version of this handler that dropped the admin check entirely (answering true for anyone
  // once the marker is on) would have passed both. Not a leak — the route itself is admin-gated
  // (`requireTenantAdmin`, break-checked separately) — but the client draws a member-row affordance
  // straight off this field with no server-side re-check, so a false `true` here is a UI entry point
  // that leads nowhere once clicked, not a security hole.
  it('registered but NOT an admin: memberIdentitiesEnabled is false — the marker alone is not enough', async () => {
    registerMemberIdentities()
    const cookie = `${SESSION_COOKIE}=${await createSession(valkey, { tenantId: TENANT, sub: PLAIN, role: 'member' })}`
    const res = await app.inject({ method: 'GET', url: '/admin/surfaces', headers: { host: HOST, cookie } })
    expect(res.statusCode, res.body).toBe(200)
    expect((res.json() as { memberIdentitiesEnabled: boolean }).memberIdentitiesEnabled, 'a non-admin member must not see the affordance').toBe(false)
  }, 60_000)
})

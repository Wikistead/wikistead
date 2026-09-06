// #1107 / ADR-280 §2 (rev5/rev6): `memberIdentitiesEnabled` on GET /admin/surfaces tracks the EE
// composition marker, not a hardcoded value — the SAME technique #723's ce-scim-surface-723.test.ts
// uses, but through the HTTP route (`app.inject`), because this field is computed in the
// `/admin/surfaces` handler itself, not in `readableAdminSurfaces()` (rev5's own precision note).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { registerMemberIdentities, resetMemberIdentitiesRegistration } from '../member-identities-sink.js'
import { pool } from '../db/pool.js'

const HOST = 'dev.localhost'
let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp(); await app.ready()
}, 60_000)

afterEach(() => resetMemberIdentitiesRegistration())
afterAll(async () => { await app.close(); await pool.end() }, 60_000)

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
})

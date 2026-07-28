// #536: adding `commenter` to BUILT_IN_ROLES also added it to RESERVED_NAMES, and RESERVED_NAMES is
// checked by parseDefinition — which BOTH create and update go through.
//
// So the reservation reached backwards in time. A tenant that had legitimately created a custom role
// named `commenter` before this ticket suddenly could not edit it at all: every PUT, including one that
// only changes capabilities and restates the name unchanged, answered 400 "collides with a built-in
// role". The only escape was to rename it — a migration nobody asked for, triggered by a release.
//
// The rule that was actually wanted is "a role may not TAKE a built-in name". Keeping the name you were
// legally given is a different case, and the two were only conflated because one `if` tested both.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { createSession } from '../auth/session.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const ADMIN = 'dev-user'

let app: FastifyInstance
let cookie = ''
let headers: Record<string, string>
const created: string[] = []

// Create through the route, then rename the row directly. That reproduces "a row that predates the
// reservation" without the fixture guessing at the roles schema — the earlier attempt in this ticket
// invented a `scope` column that migration 072 does not have, and a fixture that guesses drifts away from
// the thing it is supposed to be testing.
async function makeRole(name: string, capabilities: string[]): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/admin/roles', headers, payload: { name: `tmp-${name}-${STAMP}`, capabilities, scope: 'resource' } })
  if (res.statusCode !== 201) throw new Error(`role create: ${res.statusCode} ${res.body.slice(0, 200)}`)
  const id: string = res.json().id
  created.push(id)
  await adminPool`UPDATE roles SET name = ${name} WHERE id = ${id}`
  return id
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  cookie = `wks_sess=${await createSession(app.valkey, { tenantId: TENANT, sub: ADMIN, role: 'admin' })}`
  headers = { host: 'dev.localhost', cookie }
}, 120_000)

afterAll(async () => {
  for (const id of created) {
    await adminPool`DELETE FROM role_assignments WHERE role_id = ${id}`.catch(() => {})
    await adminPool`DELETE FROM roles WHERE id = ${id}`.catch(() => {})
  }
  await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#536: reserving a name must not brick roles that predate the reservation', () => {
  it('a pre-existing role named `commenter` can still be edited under its own name', async () => {
    const id = await makeRole(`commenter`, ['view'])
    const res = await app.inject({
      method: 'PUT', url: `/admin/roles/${id}`, headers,
      payload: { name: 'commenter', capabilities: ['view', 'comment'] },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    const [row] = await adminPool<{ capabilities: string[] }[]>`SELECT capabilities FROM roles WHERE id = ${id}`
    expect([...row.capabilities].sort(), 'the edit actually landed').toEqual(['comment', 'view'])
  }, 120_000)

  it('but nothing may TAKE a built-in name — the rule the reservation is for', async () => {
    // create
    const post = await app.inject({
      method: 'POST', url: '/admin/roles', headers,
      payload: { name: 'commenter', capabilities: ['comment'], scope: 'resource' },
    })
    expect(post.statusCode, 'a NEW role cannot claim a built-in name').toBe(400)

    // rename — the case the exemption must not open up
    const other = await makeRole(`renamer-${STAMP}`, ['view'])
    const put = await app.inject({
      method: 'PUT', url: `/admin/roles/${other}`, headers,
      payload: { name: 'commenter', capabilities: ['view'] },
    })
    expect(put.statusCode, 'a DIFFERENT role cannot rename INTO a built-in name').toBe(400)
  }, 120_000)

  it('the exemption is exact, not a substring or case escape hatch', async () => {
    const id = await makeRole(`fussy-${STAMP}`, ['view'])
    for (const name of ['Commenter', 'MANAGER', 'admin']) {
      const res = await app.inject({ method: 'PUT', url: `/admin/roles/${id}`, headers, payload: { name, capabilities: ['view'] } })
      expect(res.statusCode, `renaming to "${name}" is still refused`).toBe(400)
    }
  }, 120_000)
})

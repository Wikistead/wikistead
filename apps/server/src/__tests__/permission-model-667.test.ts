// #667 / ADR-221 §3: the two places a v2 key would have been handed the whole tenant.
//
// A v2 key carries a resource-type matrix and NEITHER `capabilities` NOR `space_ids`. Two layers had to
// learn about it, and each fails silently on its own:
//
//   `isNarrowedKey`   answers "is this key confined at all". A disjunction that lost a term reads a v2
//                     key as unconfined, and everything narrowing buys hangs off that answer — the
//                     credential-minting refusal AND the route table. This is #637's fail-open, in the
//                     same function, one dimension later.
//   `verifyApiKey`    builds the principal the function above reads. Teaching the gate about a column
//                     while leaving this SELECT alone reinstates the same hole one layer down, and every
//                     unit test that constructs a principal by hand still passes — which is why the
//                     assertion here drives a REAL REQUEST rather than calling the predicate.
//
// Nothing yet reads the matrix to decide a route (that is slice 3). What is pinned is that a key which
// carries one is treated as CONFINED, so it lands in deny-by-default rather than in its owner's rights.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { verifyApiKey } from '../api-key-auth.js'
import { isNarrowedKey } from '@wikistead/hooks'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)

let app: FastifyInstance

async function mint(cols: {
  capabilities?: string[] | null
  spaces?: string[] | null
  model?: 1 | 2
  permissions?: Record<string, string> | null
}): Promise<string> {
  const prefix = randomBytes(6).toString('base64url')
  const plaintext = `wks_${prefix}_${randomBytes(24).toString('base64url')}`
  await admin`
    INSERT INTO api_keys (tenant_id, owner_user_id, name, key_prefix, key_hash, scope,
                          capabilities, space_ids, permission_model, permissions)
    VALUES (${T}, ${OWNER}, ${`pm667-${STAMP}-${randomBytes(3).toString('hex')}`}, ${`wks_${prefix}`},
            ${createHash('sha256').update(plaintext).digest('hex')}, 'write',
            ${cols.capabilities ?? null}, ${cols.spaces ?? null}, ${cols.model ?? 1},
            ${cols.permissions ? JSON.stringify(cols.permissions) : null})`
  return plaintext
}

beforeAll(async () => { app = await buildApp(); await app.ready() }, 180_000)
afterAll(async () => {
  await admin`DELETE FROM api_keys WHERE tenant_id = ${T} AND name LIKE ${'pm667-%'}`.catch(() => {})
  await app.close(); await admin.end(); await pool.end()
}, 120_000)

describe('#667: a key that carries only a matrix is narrowed', () => {
  it('the predicate says so', () => {
    // The unit half. Cheap, and it is the layer that #637 fixed for the second dimension.
    expect(isNarrowedKey({ permissions: { pages: 'read' } }), 'a matrix confines').toBe(true)
    expect(isNarrowedKey({ permissions: {} }), 'an EMPTY matrix confines to nothing — still confined').toBe(true)
    expect(isNarrowedKey({}), 'and a key with none of the three is not narrowed').toBe(false)
    expect(isNarrowedKey({ capabilities: ['view'] })).toBe(true)
    expect(isNarrowedKey({ spaces: ['demo_space'] })).toBe(true)
  })

  it('…and the principal the request path builds actually carries it', async () => {
    // The layer the predicate depends on. `verifyApiKey` selects columns by name, so a v2 key whose
    // `permissions` never made it onto the principal reads as unnarrowed no matter what the predicate
    // says — invisible to the test above and to every hand-built fixture.
    const token = await mint({ model: 2, permissions: { pages: 'read' } })
    const result = await verifyApiKey(token, T)
    expect(result, 'the key verifies').toBeTruthy()
    const principal = result as { permissionModel?: number; permissions?: Record<string, string> }
    expect(principal.permissionModel, 'the row says which rule reads it').toBe(2)
    expect(principal.permissions, 'and the matrix rode along').toEqual({ pages: 'read' })
    expect(isNarrowedKey(principal as never), 'so the predicate can see it').toBe(true)
  }, 120_000)

  it('an unmarked key is v1 and unnarrowed, exactly as before', async () => {
    const result = await verifyApiKey(await mint({}), T)
    const principal = result as { permissionModel?: number; permissions?: unknown; capabilities?: unknown }
    expect(principal.permissionModel, 'the default is the reading that changes nothing').toBe(1)
    expect(principal.permissions).toBeUndefined()
    expect(isNarrowedKey(principal as never)).toBe(false)
  }, 120_000)

  it('a matrix-only key meets deny-by-default on a real request, not its owner’s rights', async () => {
    // The whole point, driven end to end. `GET /members` is off the v1 route table, so a confined key is
    // refused there; an UNCONFINED one reaches the route and is answered by the route's own authorization
    // (the owner is a tenant admin here, so it answers 200). The two outcomes are what separates
    // "confined" from "handed the tenant".
    const confined = await mint({ model: 2, permissions: { pages: 'read' } })
    const res = await app.inject({
      method: 'GET', url: '/members',
      headers: { host: 'dev.localhost', authorization: `Bearer ${confined}` },
    })
    expect(res.statusCode, `a matrix-only key is confined — ${res.body}`).toBe(403)
    expect(res.json<{ code?: string }>().code).toBe('narrowed_key')

    const open = await mint({})
    const control = await app.inject({
      method: 'GET', url: '/members',
      headers: { host: 'dev.localhost', authorization: `Bearer ${open}` },
    })
    expect(control.statusCode, `the control is NOT refused, or the case above proves nothing — ${control.body}`)
      .not.toBe(403)
  }, 120_000)

  it('…and it cannot mint a credential either', async () => {
    // The second thing hanging off `isNarrowedKey`. A v2 key reading as unnarrowed would have walked
    // straight onto `POST /api-keys` and made itself a peer.
    const token = await mint({ model: 2, permissions: { pages: 'read' } })
    const res = await app.inject({
      method: 'POST', url: '/api-keys',
      headers: { host: 'dev.localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: `escalate-${STAMP}` }),
    })
    expect(res.statusCode, res.body).toBe(403)
    expect(res.json<{ error: string }>().error).toBe('this API key may not issue credentials')
  }, 120_000)
})

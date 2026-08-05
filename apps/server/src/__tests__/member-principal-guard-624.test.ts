// Integration — real Postgres + real OpenFGA. #624: granting to somebody who is not a member of this
// tenant SUCCEEDED, and left an FGA tuple nobody holds.
//
// Measured on the shipped product before the fix: `POST /spaces/demo_space/access` with
// `user:definitely-not-a-member-zz9` answered 204, the roster listed the raw hex, and `space#viewer`
// existed for a principal with no members row. The validators check the SHAPE of a principal
// (`/^user:[^*\s]+$/`) and nothing else, so any string starting `user:` was accepted.
//
// The cases go through HTTP, deliberately. The guard sits at the request boundary rather than inside
// `grantSpaceAccess` — measured: wiring it into the five shared grant functions turns 125 existing tests
// red, at the boundary 16. Those functions are the mechanism; the boundary is where untrusted input
// arrives, which is the line this repo already draws ("the UI is convenience, the server is the
// fortress"). The server's side of that line is the request.
//
// The non-regression half is as load-bearing as the fix: a grant to a GROUP nobody carries yet is a
// deliberate feature (#578 OQ4 — a name the directory has not produced), so a guard that refuses unknown
// USERS must not refuse unknown groups. A fix that broke that would look identical in the tuple store.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace, listSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'dev-user'
const STAMP = Date.now().toString(36)
/** Shaped like the hex the ticket found on screen: a real sub with its tenant prefix lost. */
const STRANGER = `user:mpg624${STAMP}0000ffffdeadbeef`
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''
let roleId = ''
const cleanup: { user: string; relation: string; object: string }[] = []

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(T))
  spaceId = (await createSpace(db, fgaClient, { tenantId: T, userId: OWNER, plan: 'business', name: `mpg624-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: T, spaceId, userId: OWNER, title: `mpg624-${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  roleId = randomUUID()
  await db.sql`INSERT INTO roles (id, tenant_id, name, capabilities, scope)
               VALUES (${roleId}, ${T}, ${`mpg624-${STAMP}`}, ARRAY['view']::text[], 'resource')`
}, 180_000)

afterAll(async () => {
  await deleteTuples(fgaClient, cleanup).catch(() => {})
  await db.sql`DELETE FROM role_assignments WHERE role_id = ${roleId}`.catch(() => {})
  await db.sql`DELETE FROM roles WHERE id = ${roleId}`.catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: T, spaceId, userId: OWNER }).catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 120_000)

/** Every request that carries a principal into the store. `body(p)` puts the principal in its place. */
const DOORS: { name: string; url: () => string; body: (p: string) => Record<string, unknown> }[] = [
  { name: 'space grant', url: () => `/spaces/${spaceId}/access`, body: (p) => ({ grantee: p, relation: 'view' }) },
  { name: 'space composite grant', url: () => `/spaces/${spaceId}/access`, body: (p) => ({ grantee: p, relations: ['edit', 'comment'] }) },
  { name: 'page grant', url: () => `/pages/${pageId}/access`, body: (p) => ({ grantee: p, relation: 'view' }) },
  { name: 'page restriction', url: () => `/pages/${pageId}/restrict`, body: (p) => ({ principal: p }) },
  { name: 'role assignment', url: () => `/admin/roles/${roleId}/assignments`, body: (p) => ({ resourceType: 'space', resourceId: spaceId, principal: p }) },
]

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: H, payload })

describe('#624: a principal who is not a member of this tenant is refused, at every door', () => {
  it('every route file that validates a principal SHAPE also applies the membership guard', () => {
    // The discovery half, and the shape matters more than a count. What goes wrong is a file that checks
    // `/^user:.../` and then writes a tuple without asking whether that user is here. So: find the files
    // that do the first, and require each to do the second. A NEW route file with a principal validator
    // fails this the day it lands — the only way this bug does not come back somewhere else.
    const ROUTES = resolve(import.meta.dirname, '../routes')
    const withShapeCheck = readdirSync(ROUTES)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /\/\^user:\[\^\*\\s\]\+\$\//.test(readFileSync(resolve(ROUTES, f), 'utf8')))
    expect(withShapeCheck.length, 'the scan found the validators (a broken pattern must not pass vacuously)')
      .toBeGreaterThanOrEqual(3)
    for (const f of withShapeCheck) {
      expect(
        readFileSync(resolve(ROUTES, f), 'utf8'),
        `${f} validates a principal's shape but never asks whether they are a member (#624)`,
      ).toContain('assertGranteeIsMember')
    }
  })

  it.each(DOORS.map((d) => [d.name, d] as const))('%s refuses a non-member principal', async (_n, door) => {
    const res = await post(door.url(), door.body(STRANGER))
    expect(res.statusCode, `${res.body}`).toBe(400)
    expect(res.json().code, 'and says which rule stopped it, not a bare 400').toBe('not_a_member')
    // …and left nothing behind. A refusal that writes first is the bug with an error message on it.
    for (const object of [`space:${spaceId}`, `page:${pageId}`]) {
      const { tuples } = await fgaClient.read({ user: STRANGER, object })
      expect((tuples ?? []).length, `no tuple was written on ${object} before the refusal`).toBe(0)
    }
  }, 120_000)

  it('the guard never speaks BEFORE the existence-bind — an unknown resource still answers 404', async () => {
    // The ordering this fix nearly got wrong. #445 makes an unknown or cross-tenant resource a UNIFORM
    // 404 so a caller cannot learn whether it exists. Placed before that bind, the membership guard
    // answers 400 `not_a_member` first — which confirms the caller got past the lookup and turns an
    // existence-hiding line into an oracle. Measured: it did exactly that on the first attempt, and the
    // pin that caught it belonged to another ticket, so the statement is repeated here where it belongs.
    const res = await post(`/admin/roles/${roleId}/assignments`, {
      resourceType: 'space', resourceId: randomUUID(), principal: STRANGER,
    })
    expect(res.statusCode, `an unknown resource hides itself, whoever the principal is — ${res.body}`).toBe(404)
    expect(res.json().code, 'and not the membership refusal').not.toBe('not_a_member')
  }, 60_000)

  it('the roster never shows a principal with no member row', async () => {
    const roster = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: T, userId: OWNER })
    expect(roster.some((r) => r.grantee === STRANGER), 'the raw-hex row the ticket found').toBe(false)
  }, 60_000)

  it('a REAL member is still grantable — the guard refuses strangers, not everyone', async () => {
    // Without this the file is satisfiable by a server that refuses every grant.
    const sub = `mpg624-real-${STAMP}`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${T}, ${sub}, ${`r-${STAMP}@fixture.test`}, 'member')
                ON CONFLICT (tenant_id, sub) DO NOTHING`
    try {
      const res = await post(`/spaces/${spaceId}/access`, { grantee: `user:${sub}`, relation: 'view' })
      expect(res.statusCode, `a member of this tenant is grantable — ${res.body}`).toBe(204)
      cleanup.push({ user: `user:${sub}`, relation: 'viewer', object: `space:${spaceId}` })
      cleanup.push({ user: `user:${sub}`, relation: 'viewer_member', object: `space:${spaceId}` })
    } finally {
      await admin`DELETE FROM members WHERE tenant_id = ${T} AND sub = ${sub}`.catch(() => {})
    }
  }, 120_000)

  it('a group nobody carries yet is STILL grantable — #578 OQ4 is a feature, not this bug', async () => {
    // The non-regression that matters. An unconfirmed GROUP is deliberate: a manager names a directory
    // group before anyone carrying it has signed in. A guard written as "the principal must be known"
    // rather than "the USER must be a member" would silently retire that.
    const groupName = `mpg624-unknown-${STAMP}`
    const res = await post(`/spaces/${spaceId}/access`, { groupName, relation: 'view' })
    expect(res.statusCode, `an unconfirmed group grant is not what #624 refuses — ${res.body}`).toBe(204)
    const { groupGrantee } = await import('../auth/group-sync.js')
    const g = groupGrantee(T, groupName)
    cleanup.push({ user: g, relation: 'viewer', object: `space:${spaceId}` })
    cleanup.push({ user: g, relation: 'viewer_member', object: `space:${spaceId}` })
  }, 120_000)
})

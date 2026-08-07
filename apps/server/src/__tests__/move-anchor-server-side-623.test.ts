// #623 / ADR-220 §7: a drop resolves its anchor SERVER-SIDE — the client names "after page X" or "at
// the end", never an index — and the cycle check is server-side too, "since the client cannot be
// trusted with it".
//
// Measured, and both are already true of `movePage`: the route takes `afterId`, refuses one that is not
// a sibling, and refuses a page moved under its own descendant. What was missing is the PROOF at the
// boundary the client actually crosses.
//
// The existing case calls `movePage` directly, goes one level deep, and asserts only that something
// threw — a 500 would satisfy it as readily as a refusal. Under §7 the client stops doing the check
// itself, so the server's refusal becomes the only one there is, and it has to be measured where the
// client meets it: over HTTP, several levels down, with the status a screen would see.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

let tenant: Tenant, db: TenantDb, app: FastifyInstance
let space: string, other: string
let a: string, b: string, c: string, sibling: string, elsewhere: string

const move = (pageId: string, body: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/pages/${pageId}/move`, headers: H, payload: body })

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp(); await app.ready()
  space = (await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `mv623-${STAMP}`,
  })).id
  other = (await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `mv623-other-${STAMP}`,
  })).id
  const mk = async (sp: string, parent: string | null, title: string) => (await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId: sp, userId: 'dev-user', title, parentId: parent,
  })).id
  a = await mk(space, null, `mv623-a-${STAMP}`)
  b = await mk(space, a, `mv623-b-${STAMP}`)
  c = await mk(space, b, `mv623-c-${STAMP}`)      // a > b > c
  sibling = await mk(space, null, `mv623-sib-${STAMP}`)
  elsewhere = await mk(other, null, `mv623-elsewhere-${STAMP}`)
}, 300_000)

afterAll(async () => {
  for (const id of [c, b, a, sibling, elsewhere]) {
    await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  }
  for (const sp of [space, other]) {
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: sp, userId: 'dev-user' }).catch(() => {})
  }
  await app.close(); await app.valkey.quit().catch(() => {})
  await db.release(); await pool.end({ timeout: 5 }); await admin.end()
}, 300_000)

describe('#623 / ADR-220 §7: the anchor and the cycle are the server’s to decide', () => {
  it('⚠️ a DEEP cycle is refused over HTTP, with a status a screen can act on', async () => {
    // Two levels down, which the existing direct-call case does not reach. Under §7 the client stops
    // walking ancestors itself — an unloaded branch means it cannot — so this refusal is the only one.
    const res = await move(a, { parentId: c, afterId: null })
    expect(res.statusCode, `moving a under its own grandchild answered ${res.statusCode}: ${res.body}`).toBe(400)
    // …and the tree is unchanged, which is the part a thrown error does not prove on its own.
    const [row] = await admin<{ parent_id: string | null }[]>`SELECT parent_id FROM pages WHERE id = ${a}`
    expect(row!.parent_id, 'the refused move still happened').toBeNull()
  }, 300_000)

  it('a page cannot be moved under ITSELF either', async () => {
    const res = await move(b, { parentId: b, afterId: null })
    expect(res.statusCode, res.body).toBe(400)
  }, 300_000)

  it('⚠️ an anchor that is not a sibling is refused — the client never picks the position', async () => {
    // §7's other half: the client names a page, not an index, and the server resolves where that sits.
    // An anchor from another branch has no position in this one, and inventing one would silently put
    // the row somewhere nobody asked for.
    const res = await move(sibling, { parentId: null, afterId: c })
    expect(res.statusCode, `an anchor from another branch answered ${res.statusCode}: ${res.body}`).toBe(400)
  }, 300_000)

  it('an anchor from ANOTHER SPACE is refused too', async () => {
    const res = await move(sibling, { parentId: null, afterId: elsewhere })
    expect(res.statusCode, res.body).toBe(400)
  }, 300_000)

  it('the green path still works — a legal move lands where it was asked to', async () => {
    // Without this, refusing everything would pass every case above.
    const res = await move(c, { parentId: a, afterId: b })
    expect(res.statusCode, res.body).toBe(200)
    const [row] = await admin<{ parent_id: string | null }[]>`SELECT parent_id FROM pages WHERE id = ${c}`
    expect(row!.parent_id, 'a legal move did not take').toBe(a)
    // put it back so the fixture teardown finds the shape it built
    await move(c, { parentId: b, afterId: null })
  }, 300_000)
})

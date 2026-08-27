// #974: the lazy per-branch tree (#623 / ADR-220) never annotated `private` or `frozen` on the pages it
// returns — its SQL selects no such column, and neither `listBranch` nor `paintTree` (which wraps it)
// computed one. `d.private`/`d.frozen` were always `undefined` in the sidebar, so
// `[data-testid=tree-private-lock]` / `[data-testid=tree-frozen-badge]` could never render, regardless
// of the actual state — a structural gap in the #623 rewrite, not a caching or invalidation timing
// issue (that theory was chased and ruled out against this same symptom before the real cause was found:
// the invalidation already reaches this branch's react-query key correctly — there was simply nothing
// in the payload for it to reveal).
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
import { createPage, deletePage, setPagePrivate, setPageFrozen, listBranch, paintTree } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const SUBJ = 'user:dev-user'

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
let plainId: string
let privateId: string
let frozenId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp(); await app.ready()
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `badges974-space-${STAMP}`,
  })
  spaceId = space.id
  const mk = (title: string) => createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId: null,
  }).then((p) => p.id)
  plainId = await mk(`badges974-plain-${STAMP}`)
  privateId = await mk(`badges974-private-${STAMP}`)
  frozenId = await mk(`badges974-frozen-${STAMP}`)
  await setPagePrivate(db, fgaClient, driver, { pageId: privateId, tenantId: tenant.id, userId: 'dev-user' })
  await setPageFrozen(db, fgaClient, { pageId: frozenId, tenantId: tenant.id, userId: 'dev-user', level: 'full' })
}, 300_000)

afterAll(async () => {
  for (const id of [plainId, privateId, frozenId]) {
    await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await app.close()
  await app.valkey.quit().catch(() => {})
  await db.release()
  await pool.end({ timeout: 5 })
  await admin.end()
}, 300_000)

describe('#974: listBranch annotates the same private/frozen badges listPages always has', () => {
  it('a private page carries private:true; an untouched sibling carries private:false', async () => {
    const { pages } = await listBranch(db, fgaClient, { spaceId, parentId: null, subject: SUBJ })
    const priv = pages.find((p) => p.id === privateId)
    const plain = pages.find((p) => p.id === plainId)
    expect(priv, 'the private page must still be listed to its own manager').toBeTruthy()
    expect(priv!.private, 'the lock badge’s data').toBe(true)
    expect(plain, 'the untouched sibling must still be listed').toBeTruthy()
    expect(plain!.private, 'an untouched page must not read as private').not.toBe(true)
  }, 300_000)

  it('a frozen page carries frozen:"full"; an untouched sibling carries frozen:null', async () => {
    const { pages } = await listBranch(db, fgaClient, { spaceId, parentId: null, subject: SUBJ })
    const frozen = pages.find((p) => p.id === frozenId)
    const plain = pages.find((p) => p.id === plainId)
    expect(frozen!.frozen, 'the snowflake badge’s data').toBe('full')
    expect(plain!.frozen ?? null, 'an untouched page must not read as frozen').toBeNull()
  }, 300_000)

  it('paintTree’s root branch (what the sidebar actually mounts with) carries the same badges', async () => {
    const { branches } = await paintTree(db, fgaClient, { spaceId, subject: SUBJ })
    const root = branches.find((b) => b.parentId === null)!
    const priv = root.pages.find((p) => p.id === privateId)
    const frozen = root.pages.find((p) => p.id === frozenId)
    expect(priv!.private).toBe(true)
    expect(frozen!.frozen).toBe('full')
  }, 300_000)

  it('the HTTP route answers the same way (end to end, not just the function)', async () => {
    const res = await app.inject({ method: 'GET', url: `/spaces/${spaceId}/pages/branch`, headers: H })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { pages: { id: string; private?: boolean; frozen?: string | null }[] }
    const priv = body.pages.find((p) => p.id === privateId)
    expect(priv?.private, `the wire response: ${JSON.stringify(priv)}`).toBe(true)
  }, 300_000)
})

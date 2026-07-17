// #437 / ADR-167: delete_mode — the deletion-pathway policy knob. The anti-test matrix:
// - resolution: space NULL inherits the tenant value; the space override wins; default trash_only.
// - the knob never changes WHO: an editor (no delete verb) is refused on BOTH routes in EVERY mode
//   (the verb 403 — today's behaviour, pinned so the knob can never widen it).
// - order (no oracle): the FGA gate fires BEFORE the mode gate — an unauthorized caller gets the
//   uniform verb refusal in every mode, never the policy 400.
// - enforcement: trash_only → direct 400s even for a manager; direct_only → trash 400s; both → both
//   pathways work; the direct path funnels through physicalDeletePage (page.deleted emitted, EE
//   audit row written in-tx).
// - a mode switch never strands data: pre-existing trash stays listable/restorable/purgeable under
//   direct_only.
// Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createPage, deletePage, trashPage, directDeletePage, restorePage, purgePage, listSpaceTrash, resolveDeleteMode } from '../routes/pages.js'
import { onDomainEvent } from '@wikistead/events'
import { resolveEntitlements } from '@wikistead/entitlements'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)

let tenant: Tenant
let db: TenantDb
let spaceId: string
const EDITOR = 'dm437-editor'
const grants: { user: string; relation: string; object: string }[] = []
const pages: string[] = []

const setTenantMode = (v: string) =>
  admin`INSERT INTO tenant_settings (tenant_id, delete_mode) VALUES (${tenant.id}, ${v})
        ON CONFLICT (tenant_id) DO UPDATE SET delete_mode = ${v}`
const setSpaceMode = (v: string | null) => admin`UPDATE spaces SET delete_mode = ${v} WHERE id = ${spaceId}`

const newPage = async (title: string): Promise<string> => {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title })
  pages.push(p.id)
  return p.id
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  // Seed the space DIRECTLY (row + the two createSpace tuples) instead of via createSpace: the
  // suite's subject is delete_mode, and createSpace's creation-policy plumbing is mid-migration to
  // tenant-role capabilities (#445/ADR-171) in a parallel branch — this suite must not couple to it.
  const [row] = await admin<[{ id: string }]>`
    INSERT INTO spaces (tenant_id, name) VALUES (${tenant.id}, 'dm437') RETURNING id
  `
  spaceId = row.id
  grants.push(
    { user: `tenant:${tenant.id}`, relation: 'tenant', object: `space:${spaceId}` },
    { user: 'user:dev-user', relation: 'manager', object: `space:${spaceId}` },
    { user: `user:${EDITOR}`, relation: 'editor_member', object: `space:${spaceId}` },
  )
  await writeTuples(fgaClient, grants)
}, 60_000)

afterAll(async () => {
  await setTenantMode('trash_only')
  for (const id of pages) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteTuples(fgaClient, grants).catch(() => {})
  await deleteObjectTuples(fgaClient, `space:${spaceId}`).catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${spaceId}`.catch(() => {})
  await db.release()
  await pool.end()
  await admin.end()
}, 60_000)

describe('delete_mode resolution (#437 §1)', () => {
  it('space NULL inherits the tenant value; the space override wins; default trash_only', async () => {
    await setTenantMode('trash_only')
    await setSpaceMode(null)
    expect(await resolveDeleteMode(db, spaceId)).toBe('trash_only')
    await setTenantMode('both')
    expect(await resolveDeleteMode(db, spaceId)).toBe('both')
    await setSpaceMode('direct_only')
    expect(await resolveDeleteMode(db, spaceId)).toBe('direct_only') // override beats the tenant value
    await setSpaceMode(null)
    await setTenantMode('trash_only')
    expect(await resolveDeleteMode(db, spaceId)).toBe('trash_only')
  })
})

describe('the knob never changes WHO (#437 §2 — pinned in every mode)', () => {
  it('an editor is refused on BOTH pathways in every mode (verb gate, never the policy 400)', async () => {
    const id = await newPage('dm437-who')
    for (const mode of ['trash_only', 'both', 'direct_only']) {
      await setSpaceMode(mode)
      // the FGA refusal fires FIRST — identical in every mode (never the mode 400, no oracle)
      await expect(trashPage(db, fgaClient, driver, { pageId: id, userId: EDITOR })).rejects.toMatchObject({ statusCode: 403 })
      await expect(directDeletePage(db, fgaClient, driver, { pageId: id, userId: EDITOR })).rejects.toMatchObject({ statusCode: 403 })
    }
    await setSpaceMode(null)
    // the page survived every refusal
    const [row] = await db.sql<[{ id: string }?]>`SELECT id FROM pages WHERE id = ${id}`
    expect(row?.id).toBe(id)
  })

  it('an unauthorized caller on an ABSENT page gets the same verb refusal in every mode (no oracle)', async () => {
    for (const mode of ['trash_only', 'direct_only']) {
      await setSpaceMode(mode)
      await expect(trashPage(db, fgaClient, driver, { pageId: '00000000-0000-4000-8000-000000000437', userId: EDITOR })).rejects.toMatchObject({ statusCode: 403 })
      await expect(directDeletePage(db, fgaClient, driver, { pageId: '00000000-0000-4000-8000-000000000437', userId: EDITOR })).rejects.toMatchObject({ statusCode: 403 })
    }
    await setSpaceMode(null)
  })
})

describe('per-mode pathway enforcement (#437 §2)', () => {
  it("trash_only: the direct route 400s EVEN FOR the deleting manager; trash works", async () => {
    await setSpaceMode('trash_only')
    const id = await newPage('dm437-trashonly')
    await expect(directDeletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' })).rejects.toMatchObject({ statusCode: 400, reason: 'delete_mode' })
    await trashPage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' })
    const trash = await listSpaceTrash(db, fgaClient, { spaceId, userId: 'dev-user' })
    expect(trash.some((e) => e.id === id)).toBe(true)
    await purgePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }) // cleanup via the trash path
    await setSpaceMode(null)
  })

  it('direct_only: the trash route 400s; direct works and funnels through physicalDeletePage (event + EE audit)', async () => {
    await setSpaceMode('direct_only')
    const id = await newPage('dm437-directonly')
    await expect(trashPage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' })).rejects.toMatchObject({ statusCode: 400, reason: 'delete_mode' })
    const events: string[] = []
    const off = onDomainEvent((e) => { if ((e as { pageId?: string }).pageId === id) events.push(e.type) })
    const outboxBefore = Number((await admin`SELECT count(*)::int AS n FROM audit_outbox WHERE tenant_id = ${tenant.id} AND action = 'page.purged'`)[0]!.n)
    await directDeletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' })
    off()
    expect(events).toContain('page.deleted') // the shared physicalDeletePage emitted it
    const [row] = await db.sql<[{ id: string }?]>`SELECT id FROM pages WHERE id = ${id}`
    expect(row).toBeUndefined()
    // #437 §3: the in-tx audit intent (auditIfEntitled enqueues to audit_outbox; the reliable drain
    // owns the ledger append). Deterministic either way: entitled ⇒ exactly +1; CE ⇒ unchanged.
    const outboxAfter = Number((await admin`SELECT count(*)::int AS n FROM audit_outbox WHERE tenant_id = ${tenant.id} AND action = 'page.purged'`)[0]!.n)
    expect(outboxAfter - outboxBefore).toBe(resolveEntitlements(tenant.plan).auditLog ? 1 : 0)
    await setSpaceMode(null)
  })

  it('both: the manager can use either pathway', async () => {
    await setSpaceMode('both')
    const a = await newPage('dm437-both-a')
    const b = await newPage('dm437-both-b')
    await trashPage(db, fgaClient, driver, { pageId: a, userId: 'dev-user' })
    await purgePage(db, fgaClient, driver, { pageId: a, userId: 'dev-user' })
    await directDeletePage(db, fgaClient, driver, { pageId: b, userId: 'dev-user' })
    await setSpaceMode(null)
  })

  it('a direct delete of a TRASHED root is a uniform 404 (its permanent path stays the purge route)', async () => {
    await setSpaceMode('both')
    const id = await newPage('dm437-trashed-direct')
    await trashPage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' })
    await expect(directDeletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' })).rejects.toMatchObject({ statusCode: 404 })
    await purgePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' })
    await setSpaceMode(null)
  })

  it('a mode switch never strands data: pre-existing trash stays listable/restorable under direct_only', async () => {
    await setSpaceMode('trash_only')
    const id = await newPage('dm437-strand')
    await trashPage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' })
    await setSpaceMode('direct_only')
    const trash = await listSpaceTrash(db, fgaClient, { spaceId, userId: 'dev-user' })
    expect(trash.some((e) => e.id === id)).toBe(true) // still listed
    const { reparented } = await restorePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' })
    expect(typeof reparented).toBe('boolean') // restore still works
    const [row] = await db.sql<[{ deleted_root_id: string | null }?]>`SELECT deleted_root_id FROM pages WHERE id = ${id}`
    expect(row?.deleted_root_id).toBeNull()
    await setSpaceMode(null)
  })
})

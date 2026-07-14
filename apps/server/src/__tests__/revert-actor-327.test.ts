// #327 / ADR-143 increments 2+3: per-actor bulk revert — ONE forward restore to the revision just before
// the actor's LATEST CONTIGUOUS run, honesty-bounded (never a silent mass-revert):
//   - latest contiguous run  → one click; prose restored EXACTLY; the vandal's revisions stay in history
//     (forward-only, ADR-019); a new revision is appended, attributed to the reverting moderator.
//   - interleaved (someone else published after the actor) → 409 'not-latest' (the client routes to the
//     guided manual diff path — increment 3 is UI-only on top of the existing diff/restore).
//   - the run covers every visible revision → 409 'no-baseline' (nothing to restore to).
//   - moderation-gated (#330): moderate OR manage; a plain editor gets 403; guests can't reach the
//     member-only route at all.
// Real Postgres + OpenFGA + Valkey + storage (no mocks), modeled on revisions.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as Y from 'yjs'
import IORedis from 'ioredis'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { revertActorRun } from '../routes/revisions.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)

const VANDAL = 'anon:deadbeef1234' // the #331 pseudonymous guest actor format
const MOD = 'rev327-moderator'     // space moderator (not editor, not manager)
const ED = 'rev327-editor'         // plain space editor — must NOT pass the gate

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string
let authz: { user: string; relation: string; object: string }[] = []

const encode = (text: string) => {
  const d = new Y.Doc()
  d.getText('content').insert(0, text)
  return Buffer.from(Y.encodeStateAsUpdate(d))
}

// Insert a revision snapshot with a chosen author + timestamp (the storeYdoc/publish contract, as the
// existing revisions tests do) and advance the page's live state to match.
let clock = Date.now() - 60_000
async function addRevision(text: string, createdBy: string): Promise<string> {
  const buf = encode(text)
  clock += 1000
  await adminPool`UPDATE pages SET ydoc = ${buf}, published_md = ${text} WHERE id = ${pageId}`
  const [{ id }] = await adminPool<[{ id: string }]>`
    INSERT INTO revisions (tenant_id, page_id, ydoc, title, created_by, created_at)
    VALUES (${tenant.id}, ${pageId}, ${buf}, 'revert-327', ${createdBy}, ${new Date(clock)})
    RETURNING id
  `
  return id
}

const listRevs = () => adminPool<{ id: string; created_by: string | null }[]>`
  SELECT id, created_by FROM revisions WHERE page_id = ${pageId} ORDER BY created_at DESC`

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'revert-327-space' })
  spaceId = space.id
  const page = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'revert-327' })
  pageId = page.id
  authz = [
    // moderate_from_space rides `moderator from space` and needs the structural page#space link (a draft
    // from createPage doesn't have one — publish writes it; simulate the published state).
    { user: `space:${spaceId}`, relation: 'space', object: `page:${pageId}` },
    { user: `user:${MOD}`, relation: 'moderator', object: `space:${spaceId}` },
    { user: `user:${ED}`, relation: 'editor_member', object: `space:${spaceId}` },
  ]
  await writeTuples(fgaClient, authz)
})

afterAll(async () => {
  await deleteTuples(fgaClient, authz).catch(() => {})
  await adminPool`DELETE FROM notifications WHERE event_id IN (SELECT id FROM feed_events WHERE page_id = ${pageId})`.catch(() => {})
  await adminPool`DELETE FROM feed_events WHERE page_id = ${pageId}`.catch(() => {})
  await adminPool`DELETE FROM revisions WHERE page_id = ${pageId}`
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
  await valkey.quit()
  await adminPool.end()
})

describe('#327 revertActorRun', () => {
  it('reverts the latest contiguous run in one forward restore (prose exact, history preserved, moderator attributed)', async () => {
    const baseId = await addRevision('clean text by alice', 'user:alice')
    await addRevision('VANDALISED once', VANDAL)
    await addRevision('VANDALISED twice', VANDAL)

    const res = await revertActorRun(db, fgaClient, valkey, storage, {
      tenantId: tenant.id, pageId, actor: VANDAL, userId: MOD, plan: tenant.plan,
    })
    expect(res.restoredToRevisionId).toBe(baseId)
    expect(res.revertedCount).toBe(2)

    // the page is back to the pre-run PROSE exactly (re-published), via ONE forward restore
    const [page] = await adminPool<[{ published_md: string | null }]>`SELECT published_md FROM pages WHERE id = ${pageId}`
    expect(page.published_md).toBe('clean text by alice')

    // forward-only: nothing was deleted — base + 2 vandal revisions + 1 NEW restore revision by the moderator
    const revs = await listRevs()
    expect(revs.length).toBe(4)
    expect(revs[0]!.created_by).toBe(`user:${MOD}`)
    expect(revs.filter((r) => r.created_by === VANDAL).length).toBe(2)

    // the restore feed event landed in the SAME tx (increment 1's reliable fan-out), actor = the moderator
    const evs = await adminPool<{ actor: string }[]>`
      SELECT actor FROM feed_events WHERE page_id = ${pageId} AND event_type = 'page.restored'`
    expect(evs.some((e) => e.actor === `user:${MOD}`)).toBe(true)
  })

  it("409 'not-latest' when someone else published after the actor (routes to the guided manual path)", async () => {
    // continue from the prior state; a vandal edit buried under a legitimate fix is NOT one-clickable
    await addRevision('VANDALISED again', VANDAL)
    await addRevision('fixed by bob', 'user:bob')
    await expect(revertActorRun(db, fgaClient, valkey, storage, {
      tenantId: tenant.id, pageId, actor: VANDAL, userId: MOD, plan: tenant.plan,
    })).rejects.toMatchObject({ statusCode: 409, reason: 'not-latest' })
    // and nothing changed
    const [page] = await adminPool<[{ published_md: string | null }]>`SELECT published_md FROM pages WHERE id = ${pageId}`
    expect(page.published_md).toBe('fixed by bob')
  })

  it("409 'not-a-run' when the latest run is a SINGLE revision (one edit never bulk-reverts)", async () => {
    await adminPool`DELETE FROM revisions WHERE page_id = ${pageId}`
    await addRevision('clean text by alice', 'user:alice')
    await addRevision('VANDALISED once only', VANDAL)
    await expect(revertActorRun(db, fgaClient, valkey, storage, {
      tenantId: tenant.id, pageId, actor: VANDAL, userId: MOD, plan: tenant.plan,
    })).rejects.toMatchObject({ statusCode: 409, reason: 'not-a-run' })
    // and nothing changed — the single edit is handled by the plain per-revision restore instead
    const [page] = await adminPool<[{ published_md: string | null }]>`SELECT published_md FROM pages WHERE id = ${pageId}`
    expect(page.published_md).toBe('VANDALISED once only')
  })

  it("409 'no-baseline' when the actor's run covers every visible revision", async () => {
    await adminPool`DELETE FROM revisions WHERE page_id = ${pageId}`
    await addRevision('vandal owns all history', VANDAL)
    await addRevision('vandal owns all history 2', VANDAL) // a real run (2+,) with no baseline beneath
    await expect(revertActorRun(db, fgaClient, valkey, storage, {
      tenantId: tenant.id, pageId, actor: VANDAL, userId: MOD, plan: tenant.plan,
    })).rejects.toMatchObject({ statusCode: 409, reason: 'no-baseline' })
  })

  it("409 'no-revisions' when there is nothing to revert", async () => {
    await adminPool`DELETE FROM revisions WHERE page_id = ${pageId}`
    await expect(revertActorRun(db, fgaClient, valkey, storage, {
      tenantId: tenant.id, pageId, actor: VANDAL, userId: MOD, plan: tenant.plan,
    })).rejects.toMatchObject({ statusCode: 409, reason: 'no-revisions' })
  })

  it('is moderation-gated: a plain editor gets 403 (moderate OR manage only)', async () => {
    await addRevision('clean', 'user:alice')
    await addRevision('VANDALISED', VANDAL)
    await addRevision('VANDALISED more', VANDAL) // 2+ = a real run under thecontract
    await expect(revertActorRun(db, fgaClient, valkey, storage, {
      tenantId: tenant.id, pageId, actor: VANDAL, userId: ED, plan: tenant.plan,
    })).rejects.toMatchObject({ statusCode: 403 })
    // the manager path (manage without moderator) also passes — dev-user holds manage_direct as creator
    const res = await revertActorRun(db, fgaClient, valkey, storage, {
      tenantId: tenant.id, pageId, actor: VANDAL, userId: 'dev-user', plan: tenant.plan,
    })
    expect(res.revertedCount).toBe(2)
  })
})

// #411 / ADR-153: page trash & restore. The trash is an FGA `trashed` marker PAIR on every subtree row
// (view/edit/comment go dark — uniform 404) + row stamps (deleted_at/deleted_by/deleted_root_id); every
// underlying grant tuple SURVIVES so restore = delete the pair + clear the stamps, with NO re-grant.
// Anti-test suites 1-8 from the ADR, incl. the Review approval condition (anti-test 8: a comment-granted
// member still lands in the search viewer denorm after the comment→comment_direct leaf split).
// Real Postgres + OpenFGA (+ Fastify inject for the guest-401 route tests).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { mintGuestToken } from '@wikistead/auth'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { buildSearchDoc } from '../search/doc-builder.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import {
  createPage, deletePage, getPage, getBacklinks, getListResults,
  trashPage, restorePage, purgePage, listSpaceTrash, sweepExpiredTrash,
} from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)

let tenant: Tenant
let db: TenantDb
let spaceId: string
const ids: string[] = []

async function mkPage(title: string, md: string | null, parentId?: string): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId })
  ids.push(p.id)
  if (md !== null) {
    await adminPool`UPDATE pages SET published_md = ${md}, published_at = now() WHERE id = ${p.id}`
  }
  return p.id
}

const trashState = async (id: string) => {
  const [r] = await adminPool<[{ deleted_at: Date | null; deleted_root_id: string | null }?]>`
    SELECT deleted_at, deleted_root_id FROM pages WHERE id = ${id}
  `
  return r ?? null
}

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'trash-space' })
  spaceId = space.id
}, 60_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
  await adminPool.end()
}, 60_000)

// ── 1. trashed ≡ absent: uniform 404 for members AND guests ─────────────────
describe('anti-test 1: a trashed page is byte-identically absent (uniform 404)', () => {
  it('member view (even the manage holder), guest share_link view, and child rows all go dark', async () => {
    const root = await mkPage('T1 Root', 'body')
    const child = await mkPage('T1 Child', 'child body', root)
    const guestGrant = [{ user: 'share_link:t1-link', relation: 'view_direct', object: `page:${root}` }]
    await writeTuples(fgaClient, guestGrant)
    try {
      expect(await check(fgaClient, 'share_link:t1-link', 'view', { type: 'page', id: root })).toBe(true)

      await trashPage(db, fgaClient, driver, { pageId: root, userId: 'dev-user' })

      // The CREATOR (manage holder) gets the SAME 404 as a stranger — view is cut, manage is not.
      await expect(getPage(db, fgaClient, { pageId: root, userId: 'dev-user' })).rejects.toMatchObject({ statusCode: 404 })
      await expect(getPage(db, fgaClient, { pageId: child, userId: 'dev-user' })).rejects.toMatchObject({ statusCode: 404 })
      // The share-link guest's grant tuple SURVIVES but the marker subtracts it.
      expect(await check(fgaClient, 'share_link:t1-link', 'view', { type: 'page', id: root })).toBe(false)
      // edit and comment are cut too; manage survives (it is the restore/purge authority).
      expect(await check(fgaClient, 'user:dev-user', 'edit', { type: 'page', id: root })).toBe(false)
      expect(await check(fgaClient, 'user:dev-user', 'comment', { type: 'page', id: root })).toBe(false)
      expect(await check(fgaClient, 'user:dev-user', 'manage', { type: 'page', id: root })).toBe(true)
      // Both rows are stamped with the SAME root.
      expect((await trashState(root))?.deleted_root_id).toBe(root)
      expect((await trashState(child))?.deleted_root_id).toBe(root)
      // Idempotent: a second trash is a no-op, not an error.
      await trashPage(db, fgaClient, driver, { pageId: root, userId: 'dev-user' })
    } finally {
      await deleteTuples(fgaClient, guestGrant).catch(() => {})
      await restorePage(db, fgaClient, driver, { pageId: root, userId: 'dev-user' }).catch(() => {})
    }
  })
})

// ── 2. search: doc gone at trash, back at restore ────────────────────────────
describe('anti-test 2: the search doc dies at trash and returns at restore', () => {
  it('buildSearchDoc → null while trashed (→ delete), doc again after restore; trash enqueues delete rows', async () => {
    const p = await mkPage('T2 Searchable', 'searchable body')
    expect(await buildSearchDoc(pool, fgaClient, p, tenant.id)).not.toBeNull()

    await trashPage(db, fgaClient, driver, { pageId: p, userId: 'dev-user' })
    // The doc-builder treats a trashed row as absent — a racing 'upsert' can never re-index it.
    expect(await buildSearchDoc(pool, fgaClient, p, tenant.id)).toBeNull()

    await restorePage(db, fgaClient, driver, { pageId: p, userId: 'dev-user' })
    const doc = await buildSearchDoc(pool, fgaClient, p, tenant.id)
    expect(doc).not.toBeNull()
    expect(doc!.title).toBe('T2 Searchable')
  })
})

// ── 3. candidate surfaces omit trashed rows ──────────────────────────────────
describe('anti-test 3: backlinks / children / tree listing omit a trashed page', () => {
  it('a trashed page vanishes from getBacklinks sources and :::children results', async () => {
    const target = await mkPage('T3 Target', 'target body')
    const linker = await mkPage('T3 Linker', `see [t](/p/${target})\n`)
    const parent = await mkPage('T3 Parent', 'parent body')
    const child = await mkPage('T3 Child', 'child body', parent)

    expect((await getBacklinks(db, fgaClient, { pageId: target, subject: 'user:dev-user' })).map((b) => b.id)).toContain(linker)
    expect((await getListResults(db, fgaClient, { pageId: parent, name: 'children', body: '', subject: 'user:dev-user' })).map((r) => r.id)).toContain(child)

    await trashPage(db, fgaClient, driver, { pageId: linker, userId: 'dev-user' })
    await trashPage(db, fgaClient, driver, { pageId: child, userId: 'dev-user' })
    try {
      expect((await getBacklinks(db, fgaClient, { pageId: target, subject: 'user:dev-user' })).map((b) => b.id)).not.toContain(linker)
      expect((await getListResults(db, fgaClient, { pageId: parent, name: 'children', body: '', subject: 'user:dev-user' })).map((r) => r.id)).not.toContain(child)
    } finally {
      await restorePage(db, fgaClient, driver, { pageId: linker, userId: 'dev-user' }).catch(() => {})
      await restorePage(db, fgaClient, driver, { pageId: child, userId: 'dev-user' }).catch(() => {})
    }
  })
})

// ── 4. restore fidelity: grants come back verbatim, nothing is re-granted ────
describe('anti-test 4: restore brings access back exactly as it was', () => {
  it('a direct member grant AND a share-link grant work again after restore with NO tuple rewrite', async () => {
    const p = await mkPage('T4 Shared', 'shared body')
    const grants = [
      { user: 'user:member-t4', relation: 'view_direct', object: `page:${p}` },
      { user: 'share_link:t4-link', relation: 'view_direct', object: `page:${p}` },
    ]
    await writeTuples(fgaClient, grants)
    try {
      await trashPage(db, fgaClient, driver, { pageId: p, userId: 'dev-user' })
      expect(await check(fgaClient, 'user:member-t4', 'view', { type: 'page', id: p })).toBe(false)
      const r = await restorePage(db, fgaClient, driver, { pageId: p, userId: 'dev-user' })
      expect(r.reparented).toBe(false)
      // The ORIGINAL tuples (written once, never rewritten) are live again.
      expect(await check(fgaClient, 'user:member-t4', 'view', { type: 'page', id: p })).toBe(true)
      expect(await check(fgaClient, 'share_link:t4-link', 'view', { type: 'page', id: p })).toBe(true)
      expect((await trashState(p))?.deleted_at).toBeNull()
    } finally {
      await deleteTuples(fgaClient, grants).catch(() => {})
    }
  })

  it('restoring a root whose parent is still trashed re-parents it to the space root', async () => {
    const parent = await mkPage('T4 Parent', 'p')
    const child = await mkPage('T4 Child', 'c', parent)
    await trashPage(db, fgaClient, driver, { pageId: child, userId: 'dev-user' })  // child is its OWN root
    await trashPage(db, fgaClient, driver, { pageId: parent, userId: 'dev-user' }) // parent trashed separately
    const r = await restorePage(db, fgaClient, driver, { pageId: child, userId: 'dev-user' })
    expect(r.reparented).toBe(true) // its parent is in the trash — the child can't hang under it
    const [row] = await adminPool<[{ parent_id: string | null }?]>`SELECT parent_id FROM pages WHERE id = ${child}`
    expect(row?.parent_id).toBeNull()
    await restorePage(db, fgaClient, driver, { pageId: parent, userId: 'dev-user' })
  })

  it('purging a root also destroys a NESTED trash root inside it (physical cascade, tuples swept)', async () => {
    const outer = await mkPage('T4 PurgeOuter', 'o')
    const inner = await mkPage('T4 PurgeInner', 'i', outer)
    await trashPage(db, fgaClient, driver, { pageId: inner, userId: 'dev-user' }) // nested, own root
    await trashPage(db, fgaClient, driver, { pageId: outer, userId: 'dev-user' })
    await purgePage(db, fgaClient, driver, { pageId: outer, userId: 'dev-user' })
    // BOTH rows are gone — a nested entry never survives its ancestor's purge as an invisible orphan.
    expect(await trashState(outer)).toBeNull()
    expect(await trashState(inner)).toBeNull()
  })

  it('a NESTED older trash root stays trashed when the outer root is restored (deleted_root_id keying)', async () => {
    const outer = await mkPage('T4 Outer', 'o')
    const inner = await mkPage('T4 Inner', 'i', outer)
    await trashPage(db, fgaClient, driver, { pageId: inner, userId: 'dev-user' }) // older, own root
    await trashPage(db, fgaClient, driver, { pageId: outer, userId: 'dev-user' }) // outer trashes AROUND it
    expect((await trashState(inner))?.deleted_root_id).toBe(inner) // kept its own entry
    await restorePage(db, fgaClient, driver, { pageId: outer, userId: 'dev-user' })
    // The outer subtree is back; the inner root is STILL its own trash entry (restorable separately).
    expect((await trashState(outer))?.deleted_at).toBeNull()
    expect((await trashState(inner))?.deleted_at).not.toBeNull()
    await restorePage(db, fgaClient, driver, { pageId: inner, userId: 'dev-user' })
    expect((await trashState(inner))?.deleted_at).toBeNull()
  })
})

// ── 5. trash listing: manage omit-on-deny, no leak past the gate ─────────────
describe('anti-test 5: listSpaceTrash leaks nothing past manage', () => {
  it('roots only; a viewer without page-manage sees an EMPTY list (no title/count leak); unknown space 404', async () => {
    const root = await mkPage('T5 Root', 'r')
    const child = await mkPage('T5 Child', 'c', root)
    await trashPage(db, fgaClient, driver, { pageId: root, userId: 'dev-user' })
    const viewerGrant = [{ user: 'user:viewer-t5', relation: 'viewer', object: `space:${spaceId}` }]
    await writeTuples(fgaClient, viewerGrant)
    try {
      const mine = await listSpaceTrash(db, fgaClient, { spaceId, userId: 'dev-user' })
      const entry = mine.find((e) => e.id === root)
      expect(entry).toBeDefined()
      expect(entry!.descendants).toBe(1)
      expect(mine.map((e) => e.id)).not.toContain(child) // roots only — the child rides its root's entry

      // A space member who can view but not manage the trashed page: 200 with the entry OMITTED.
      const theirs = await listSpaceTrash(db, fgaClient, { spaceId, userId: 'viewer-t5' })
      expect(theirs.map((e) => e.id)).not.toContain(root)
      expect(theirs.map((e) => e.title)).not.toContain('T5 Root')

      // No space view at all / unknown space → uniform 404 (the trash is not a probe surface).
      await expect(listSpaceTrash(db, fgaClient, { spaceId, userId: 'stranger-t5' })).rejects.toMatchObject({ statusCode: 404 })
      await expect(listSpaceTrash(db, fgaClient, { spaceId: 'no-such-space', userId: 'dev-user' })).rejects.toMatchObject({ statusCode: 404 })
    } finally {
      await deleteTuples(fgaClient, viewerGrant).catch(() => {})
      await restorePage(db, fgaClient, driver, { pageId: root, userId: 'dev-user' }).catch(() => {})
    }
  })
})

// ── 6. restore/purge authz: uniform 404; guests are 401 at the route ─────────
describe('anti-test 6: restore/purge/list deny correctly', () => {
  it('restore/purge: non-manage caller and non-root target are the SAME uniform 404', async () => {
    const root = await mkPage('T6 Root', 'r')
    const child = await mkPage('T6 Child', 'c', root)
    await trashPage(db, fgaClient, driver, { pageId: root, userId: 'dev-user' })
    try {
      // A stranger probing a trashed id learns nothing (manage denied → 404, same as absent).
      await expect(restorePage(db, fgaClient, driver, { pageId: root, userId: 'stranger' })).rejects.toMatchObject({ statusCode: 404 })
      await expect(purgePage(db, fgaClient, driver, { pageId: root, userId: 'stranger' })).rejects.toMatchObject({ statusCode: 404 })
      // A NON-ROOT (rode along) is not independently restorable/purgable — same 404, even for the manage holder.
      await expect(restorePage(db, fgaClient, driver, { pageId: child, userId: 'dev-user' })).rejects.toMatchObject({ statusCode: 404 })
      await expect(purgePage(db, fgaClient, driver, { pageId: child, userId: 'dev-user' })).rejects.toMatchObject({ statusCode: 404 })
      // A LIVE (non-trashed) page can't be purged directly either.
      const live = await mkPage('T6 Live', 'l')
      await expect(purgePage(db, fgaClient, driver, { pageId: live, userId: 'dev-user' })).rejects.toMatchObject({ statusCode: 404 })
      // An unknown id: 404.
      await expect(restorePage(db, fgaClient, driver, { pageId: 'no-such-page', userId: 'dev-user' })).rejects.toMatchObject({ statusCode: 404 })
    } finally {
      await restorePage(db, fgaClient, driver, { pageId: root, userId: 'dev-user' }).catch(() => {})
    }
  })

  it('ROUTES: a share_link guest token is rejected (no guest config on restore/purge/trash)', async () => {
    const app: FastifyInstance = await buildApp()
    await app.ready()
    try {
      const guestTok = await mintGuestToken({ secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }, { tenantId: 'tenant_dev', shareLinkId: 'demo_view_perm', resource: { type: 'page', id: 'demo' }, capability: 'view' })
      for (const req of [
        { method: 'POST' as const, url: '/pages/demo/restore' },
        { method: 'DELETE' as const, url: '/pages/demo/purge' },
        { method: 'GET' as const, url: `/spaces/${spaceId}/trash` },
      ]) {
        const res = await app.inject({ ...req, headers: { host: 'dev.localhost', authorization: `Bearer ${guestTok}` } })
        expect(res.statusCode, `${req.method} ${req.url}`).toBeGreaterThanOrEqual(401)
        expect(res.statusCode, `${req.method} ${req.url}`).not.toBe(200)
      }
    } finally {
      await app.close()
    }
  })
})

// ── 7+8. comment_direct leaf split: capability intact + search denorm intact ─
describe('anti-tests 7/8: the comment→comment_direct leaf split (Review approval condition)', () => {
  it('a comment_direct grant confers comment (and its view), and trash subtracts it', async () => {
    const p = await mkPage('T7 Commentable', 'c')
    const grant = [{ user: 'user:commenter-t7', relation: 'comment_direct', object: `page:${p}` }]
    await writeTuples(fgaClient, grant)
    try {
      expect(await check(fgaClient, 'user:commenter-t7', 'comment', { type: 'page', id: p })).toBe(true)
      expect(await check(fgaClient, 'user:commenter-t7', 'view', { type: 'page', id: p })).toBe(true)
      await trashPage(db, fgaClient, driver, { pageId: p, userId: 'dev-user' })
      expect(await check(fgaClient, 'user:commenter-t7', 'comment', { type: 'page', id: p })).toBe(false)
      await restorePage(db, fgaClient, driver, { pageId: p, userId: 'dev-user' })
      expect(await check(fgaClient, 'user:commenter-t7', 'comment', { type: 'page', id: p })).toBe(true)
    } finally {
      await deleteTuples(fgaClient, grant).catch(() => {})
    }
  })

  it('ANTI-TEST 8: a comment-granted member is in the search viewer denorm (doc-builder reads comment_direct)', async () => {
    const p = await mkPage('T8 Indexed', 'indexed body')
    const grant = [{ user: 'user:commenter-t8', relation: 'comment_direct', object: `page:${p}` }]
    await writeTuples(fgaClient, grant)
    try {
      const doc = await buildSearchDoc(pool, fgaClient, p, tenant.id)
      expect(doc).not.toBeNull()
      // The approval condition: reading the old 'comment' relation here would silently drop them.
      expect(doc!.viewerUsers).toContain('user:commenter-t8')
    } finally {
      await deleteTuples(fgaClient, grant).catch(() => {})
    }
  })
})

// ── retention sweep ───────────────────────────────────────────────────────────
describe('retention: expired trash entries are purged; the sweep is idempotent', () => {
  it('a >30-day-old root (and its subtree) is physically deleted; a fresh one survives; rerun is a no-op', async () => {
    const oldRoot = await mkPage('TR Old', 'o')
    const oldChild = await mkPage('TR Old Child', 'oc', oldRoot)
    const freshRoot = await mkPage('TR Fresh', 'f')
    await trashPage(db, fgaClient, driver, { pageId: oldRoot, userId: 'dev-user' })
    await trashPage(db, fgaClient, driver, { pageId: freshRoot, userId: 'dev-user' })
    // Age the old root PAST retention (both its rows — the sweep keys on the ROOT row's deleted_at).
    await adminPool`UPDATE pages SET deleted_at = now() - interval '31 days' WHERE deleted_root_id = ${oldRoot}`

    const purged = await sweepExpiredTrash(fgaClient, driver)
    expect(purged).toBeGreaterThanOrEqual(1)
    expect(await trashState(oldRoot)).toBeNull()  // row gone
    expect(await trashState(oldChild)).toBeNull() // subtree gone (cascade)
    expect((await trashState(freshRoot))?.deleted_at).not.toBeNull() // fresh entry untouched

    const again = await sweepExpiredTrash(fgaClient, driver)
    expect(again).toBe(0)

    await restorePage(db, fgaClient, driver, { pageId: freshRoot, userId: 'dev-user' })
  }, 60_000)
})

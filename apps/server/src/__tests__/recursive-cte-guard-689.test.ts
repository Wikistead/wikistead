// #689: a parent cycle must never make a recursive CTE spin forever.
//
// Measured before the fix: one `ancestorDepth` query ran for 5 days 8 hours (4.5 CPU-days) holding its
// pooled connection — every request touching the cyclic family eats another connection until the whole
// tenant stops answering. Cycles arrive two ways: the concurrent-move TOCTOU (two ordinary UI drags),
// and direct SQL outside the API (fixtures, repair scripts — the measured instance).
//
// Three layers, three pins:
//   1. every recursive CTE in the tree carries a depth bound — a SWEEP, not a list, so the fourth
//      unbounded walk fails here the day it is written (#683's lesson);
//   2. the three walks REFUSE (500 page_tree_corrupt) at the cap rather than clamp — a truncated depth
//      would make the create/move guards approve what they should refuse (fail-open);
//   3. movePage's check-then-write runs under a per-space advisory xact lock, measured by observation
//      (a held lock blocks the move), not just asserted by reading the source.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
// @ts-expect-error — repo-root script (no types; the image build has no scripts/, #621 convention)
import { eeServerSourceRoot } from '../../../../scripts/ee-source-root.mjs'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import {
  createPage, movePage, descendantIds, ancestorDepth, subtreeHeight, PAGE_TREE_WALK_CAP, MAX_PAGE_DEPTH,
} from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
let tenant: Tenant
let db: TenantDb
let spaceId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'cte-guard-689' })
  spaceId = space.id
})
afterAll(async () => {
  // The cyclic rows must be un-cycled before deleteSpace walks the space, for the same reason this
  // file exists: the walks refuse corrupt trees.
  await db.sql`UPDATE pages SET parent_id = NULL WHERE space_id = ${spaceId} AND title LIKE 'cyc-%'`
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  await db.release()
  await pool.end()
})

const mk = (title: string, parentId: string | null = null) =>
  createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId })

// ── layer 1: the sweep — no recursive CTE without a depth bound, anywhere ────────────────────────────
//
// Discovery-shaped: walks the source trees rather than naming files, so a NEW unbounded walk is caught,
// not only regressions in the three that spun. The EE tree is included via the same overlay resolution
// the filter uses (0 recursive CTEs there today — the sweep is what keeps that claim current).
describe('#689 sweep: every recursive CTE carries a depth bound', () => {
  const roots = [resolve(import.meta.dirname, '..')]
  // The EE tree joins through the ONE resolver (#178): hard-coding its candidate paths here is what
  // that ticket's own discovery belt exists to refuse.
  const eeRoot = eeServerSourceRoot(resolve(import.meta.dirname, '../../../..')) as string | null
  if (eeRoot && existsSync(eeRoot)) roots.push(eeRoot)

  const tsFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : tsFiles(p)
      return p.endsWith('.ts') ? [p] : []
    })

  // Comments are prose: strip them so a sentence ABOUT a recursive CTE is not scanned as one.
  const codeOnly = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n')

  it('finds the known walks and zero unbounded ones', () => {
    const found: { file: string; bounded: boolean }[] = []
    for (const root of roots) {
      for (const file of tsFiles(root)) {
        const src = codeOnly(readFileSync(file, 'utf8'))
        for (const m of src.matchAll(/WITH\s+RECURSIVE/gi)) {
          // The recursive arm lives between the match and the closing of the template literal; the
          // window is generous because a bound placed after the arm would still bound the walk.
          const window = src.slice(m.index, m.index + 1200)
          const bounded = /\.(depth|lvl)\s*<\s*/.test(window)
          found.push({ file: file.replace(/^.*apps\/server\//, '').replace(/^.*ee-server\//, 'ee-server/'), bounded })
        }
      }
    }
    // The scan must be alive: pages.ts alone holds five walks today. A refactor that moves them is
    // fine; a count of zero means the scan broke, not that the walks left.
    expect(found.length, 'the sweep found no recursive CTEs at all — the scan broke').toBeGreaterThanOrEqual(5)
    const unbounded = found.filter((f) => !f.bounded)
    expect(unbounded, `recursive CTEs without a depth bound: ${unbounded.map((u) => u.file).join(', ')}`).toEqual([])
  })
})

// ── layers 2 & 3: the live behaviour, on a REAL cycle made the way the measured one was ──────────────
describe('#689 walks refuse a corrupt tree; movePage serializes check-and-write', () => {
  it('all three walks return promptly with page_tree_corrupt on a parent cycle (A→B→A)', async () => {
    const a = await mk('cyc-A')
    const b = await mk('cyc-B', a.id)
    // Direct SQL, outside the API — the guards cannot refuse what never passes through them.
    await db.sql`UPDATE pages SET parent_id = ${b.id} WHERE id = ${a.id}`
    for (const [name, run] of [
      ['ancestorDepth', () => ancestorDepth(db.sql, a.id)],
      ['subtreeHeight', () => subtreeHeight(db.sql, a.id)],
      ['descendantIds', () => descendantIds(db.sql, a.id)],
    ] as const) {
      const err = await run().then(() => null, (e: unknown) => e as { statusCode?: number; code?: string })
      expect(err, `${name} answered normally on a cyclic tree — a truncated answer is fail-open`).not.toBeNull()
      expect(err!.statusCode, `${name} refused with the wrong status`).toBe(500)
      expect(err!.code).toBe('page_tree_corrupt')
    }
  })

  it('a cycle in one family does not break the move guard for a healthy one (still 400, not a hang)', async () => {
    // The cyclic cyc-A/cyc-B rows from the previous test are still in this space.
    const p = await mk('healthy-parent')
    const c = await mk('healthy-child', p.id)
    await expect(
      movePage(db, fgaClient, driver, { pageId: p.id, userId: 'dev-user', parentId: c.id, afterId: null }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('legal full-depth trees stay strictly below the cap (the margin is real, not decorative)', async () => {
    let parent: { id: string } | null = null
    for (let d = 0; d <= MAX_PAGE_DEPTH; d++) parent = await mk(`deep-${d}`, parent?.id ?? null)
    // The deepest legal page answers, and its depth is under the walk cap with room to spare.
    const depth = await ancestorDepth(db.sql, parent!.id)
    expect(depth).toBe(MAX_PAGE_DEPTH)
    expect(depth).toBeLessThan(PAGE_TREE_WALK_CAP)
  })

  it('movePage waits for the per-space advisory lock (the serialization is observable, not asserted)', async () => {
    const x = await mk('lock-X')
    const y = await mk('lock-Y')
    const db2 = await acquireTenantDb(tenant)
    try {
      let release!: () => void
      const held = new Promise<void>((r) => { release = r })
      const holder = db2.tx(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`page-move:${spaceId}`})::bigint)`
        await held // keep the tx (and the lock) open until the probe has measured
      })
      let settled = false
      const move = movePage(db, fgaClient, driver, { pageId: y.id, userId: 'dev-user', parentId: x.id, afterId: null })
        .finally(() => { settled = true })
      await new Promise((r) => setTimeout(r, 300))
      // With the lock held elsewhere, the move's check-and-write section cannot have run to completion.
      expect(settled, 'movePage completed while the per-space lock was held — the move does not take it').toBe(false)
      release()
      await holder
      await move // …and it completes once the lock frees
      expect(settled).toBe(true)
    } finally {
      await db2.release()
    }
  })

  it('two opposite concurrent moves cannot commit a cycle (the TOCTOU that made the measured one)', async () => {
    const a = await mk('race-A')
    const b = await mk('race-B')
    const db2 = await acquireTenantDb(tenant)
    try {
      const [ra, rb] = await Promise.allSettled([
        movePage(db, fgaClient, driver, { pageId: a.id, userId: 'dev-user', parentId: b.id, afterId: null }),
        movePage(db2, fgaClient, driver, { pageId: b.id, userId: 'dev-user', parentId: a.id, afterId: null }),
      ])
      // Serialized, the second move sees the first's commit and refuses as nest-under-own-descendant.
      expect([ra.status, rb.status].filter((s) => s === 'rejected').length).toBe(1)
      // And the family is still a tree: the walks answer instead of throwing page_tree_corrupt.
      await expect(ancestorDepth(db.sql, a.id)).resolves.toBeGreaterThanOrEqual(0)
      await expect(ancestorDepth(db.sql, b.id)).resolves.toBeGreaterThanOrEqual(0)
    } finally {
      await db2.release()
    }
  })
})

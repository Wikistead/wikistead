// #623 / ADR-220 §4 (ruling②): a page the reader CAN see, under a parent they cannot, appears
// in the tree behind an unnamed placeholder — for all three of §4.0's causes, with §4.1's two blocked
// leaks actually blocked.
//
// Red first: before this module, the count of granted-but-unplaced pages in the tree was ZERO.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, publishPage, setPagePrivate, restrictPageAccess, listBranch, branchPlaceholders, paintTree } from '../routes/pages.js'
import { TREE_VIEW_LEAVES, resolveTreePlaceholders } from '../routes/tree-placeholders.js'
import { groupGrantee } from '../auth/group-sync.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)

let tenant: Tenant
let db: TenantDb
let spaceId: string
const made: string[] = []
const READER = `user:zz623ph-reader-${STAMP}`
const GROUP = `zz623ph-group-${STAMP}`

async function page(title: string, parentId: string | null, opts: { publish?: boolean } = {}): Promise<string> {
  const p = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId,
  })
  made.unshift(p.id)
  if (opts.publish !== false) {
    await publishPage(db, fgaClient, driver, storage, { pageId: p.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })
  }
  return p.id
}

// #623②: the chains come from the FOLLOW-UP resolver now; the branch itself never resolves
// them. The assertions below ask this, plus one paint-path regression pin at the bottom.
const branch = (parent: string | null, subject = READER) =>
  branchPlaceholders(db, fgaClient, {
    spaceId, parentId: parent, subject, tenantId: tenant.id,
    groups: subject === READER ? [GROUP] : [],
  })

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `ph623-${STAMP}`,
  })
  spaceId = space.id
  // The reader: a member who can view the space and MANAGES NOTHING — dev-user creates every page and
  // so holds manage_direct everywhere, which is exactly the vantage this file must not measure from.
  await writeTuples(fgaClient, [
    { user: READER, relation: 'member', object: `tenant:${tenant.id}` },
    { user: READER, relation: 'viewer', object: `space:${spaceId}` },
  ]).catch(() => {})
}, 300_000)

afterAll(async () => {
  for (const id of made) {
    await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end({ timeout: 5 })
  await admin.end()
}, 300_000)

describe('#623 §4: all three invisibility causes anchor a placeholder', () => {
  it('a granted page under a PRIVATE parent appears behind a placeholder', async () => {
    const parent = await page(`ph-priv-${STAMP}`, null)
    const child = await page(`ph-priv-child-${STAMP}`, parent)
    await setPagePrivate(db, fgaClient, driver, { pageId: parent, tenantId: tenant.id, userId: 'dev-user' })
    // the grant: the private marker cascades, so the child needs its own direct tuple to stay visible
    await writeTuples(fgaClient, [{ user: READER, relation: 'view_direct', object: `page:${child}` }])

    const b = await branch(null)
    const rows = await listBranch(db, fgaClient, { spaceId, parentId: null, subject: READER })
    expect(rows.pages.map((p) => p.id), 'the private parent leaked into the page list').not.toContain(parent)
    const holder = (b.placeholders ?? []).find((n) => n.pages.some((p) => p.id === child))
    expect(holder, 'the granted child was handed over and never arrived').toBeTruthy()
    expect(holder!.under, 'the chain hangs off the branch root').toBeNull()
    // §4.1's blocked rows, on the wire: nothing of the invisible parent ships.
    const wire = JSON.stringify(b)
    expect(wire, 'the invisible parent\'s id shipped').not.toContain(parent)
    expect(wire, 'the invisible parent\'s title shipped').not.toContain(`ph-priv-${STAMP}`)
  }, 300_000)

  it('a published page under a DRAFT parent appears (path 2 — no grant anywhere)', async () => {
    const draft = await page(`ph-draft-${STAMP}`, null, { publish: false })
    const child = await page(`ph-draft-child-${STAMP}`, draft)

    const b = await branch(null)
    const holder = (b.placeholders ?? []).find((n) => n.pages.some((p) => p.id === child))
    expect(holder, 'the published child under a draft parent is unreachable in the tree').toBeTruthy()
    expect(JSON.stringify(b)).not.toContain(`ph-draft-${STAMP}`)
  }, 300_000)

  it('a published page under a parent the reader is RESTRICTED on appears (the cause SQL cannot see)', async () => {
    const parent = await page(`ph-restr-${STAMP}`, null)
    const child = await page(`ph-restr-child-${STAMP}`, parent)
    await restrictPageAccess(db, fgaClient, driver, {
      pageId: parent, tenantId: tenant.id, userId: 'dev-user', principal: READER,
    })

    const b = await branch(null)
    const holder = (b.placeholders ?? []).find((n) => n.pages.some((p) => p.id === child))
    expect(holder, 'a restricted parent hid its published child — the class a published-based walk misses').toBeTruthy()
  }, 300_000)

  it('the grant read finds a GROUP grant on its own (path 1, isolated: no seeds for path 2)', async () => {
    // visible A (collapsed) → private B → child granted to the READER'S GROUP.
    const a = await page(`ph-anc-${STAMP}`, null)
    const b0 = await page(`ph-anc-mid-${STAMP}`, a)
    const child = await page(`ph-anc-child-${STAMP}`, b0)
    await setPagePrivate(db, fgaClient, driver, { pageId: b0, tenantId: tenant.id, userId: 'dev-user' })
    await writeTuples(fgaClient, [
      { user: READER, relation: 'member', object: `group:${groupGrantee(tenant.id, GROUP).slice('group:'.length).replace('#member', '')}` },
      { user: groupGrantee(tenant.id, GROUP), relation: 'view_direct', object: `page:${child}` },
    ]).catch(() => {})

    // ⚠️ Isolated from path 2 by construction (the first draft resolved the branch and stayed GREEN
    // with the whole grant read deleted — path 2 descends to the same answer wherever the chain
    // starts at the branch). Seeds are EMPTY: any placement can only come from the grant read.
    const r = await resolveTreePlaceholders(db, fgaClient, {
      spaceId, tenantId: tenant.id, branchParentId: a, subject: READER, groups: [GROUP],
      invisibleChildIds: [], toPage: (row) => ({ id: row.id as string }),
    })
    const holder = r.placeholders.find((n) => n.pages.some((p) => p.id === child))
    expect(holder, 'the group-granted page never arrived through the grant read').toBeTruthy()
    expect(holder!.under, 'the chain hangs off the resolved branch parent').toBe(a)
  }, 300_000)
})

describe('#623 §4: what a placeholder must NOT do', () => {
  it('an all-invisible subtree leaves no trace (the existence-hiding half of ruling ②)', async () => {
    const lonely = await page(`ph-lonely-${STAMP}`, null, { publish: false })
    const alsoDraft = await page(`ph-lonely-child-${STAMP}`, lonely, { publish: false })
    void alsoDraft
    const b = await branch(null)
    const wire = JSON.stringify(b)
    expect(wire, 'a subtree with nothing visible inside drew an anchor').not.toContain(`ph-lonely-${STAMP}`)
    expect(wire).not.toContain(lonely)
  }, 300_000)

  it('a share_link subject resolves nothing (§4.4: settled by principal type)', async () => {
    const r = await branchPlaceholders(db, fgaClient, {
      spaceId, parentId: null, subject: `share_link:zz623ph-${STAMP}`, tenantId: tenant.id, groups: [],
      context: { current_time: new Date().toISOString() },
    }).catch(() => null)
    if (r) expect(r.placeholders ?? []).toEqual([])
  }, 300_000)

  it('exhausting the budget is a visible state, not a short answer that looks complete', async () => {
    const res = await resolveTreePlaceholders(db, fgaClient, {
      spaceId, tenantId: tenant.id, branchParentId: null, subject: READER, groups: [],
      invisibleChildIds: made.slice(0, 3), toPage: (r) => ({ id: r.id as string }),
      budget: { left: 1 },
    })
    expect(res.placeholdersExhausted, 'the budget ran out silently').toBe(true)
  }, 300_000)

  it('②: the PAINT resolves no chains — a hidden grant is absent there and present in the follow-up', async () => {
    // The regression pin the rejection asked for: " paint ". A fixture
    // with a real hidden-grant chain paints WITHOUT it (nothing visible waits on a roster read), and
    // the follow-up resolver DOES place it (the feature is not lost).
    const parent = await page(`ph-paint-${STAMP}`, null)
    const child = await page(`ph-paint-child-${STAMP}`, parent)
    await setPagePrivate(db, fgaClient, driver, { pageId: parent, tenantId: tenant.id, userId: 'dev-user' })
    await writeTuples(fgaClient, [{ user: READER, relation: 'view_direct', object: `page:${child}` }]).catch(() => {})

    const painted = await paintTree(db, fgaClient, { spaceId, subject: READER })
    expect(JSON.stringify(painted), 'the paint carried a placeholder — the resolution is back on the hot path')
      .not.toContain(child)

    const follow = await branch(null)
    expect((follow.placeholders ?? []).some((n) => n.pages.some((p) => p.id === child)),
      'the follow-up no longer places the chain the paint stopped carrying').toBe(true)
  }, 300_000)

  it('①: a chevron means a VISIBLE child — rows without one draw none, and invisible-only rows tell nothing', async () => {
    // visible parent A with a visible child → hasChildren true.
    const a = await page(`ch-a-${STAMP}`, null)
    await page(`ch-a-kid-${STAMP}`, a)
    // visible parent B with an INVISIBLE-only child (draft; READER holds no grant) → hasChildren false
    // the corrected leak reading — an invisible child is reported as ABSENT, telling nothing.
    const b0 = await page(`ch-b-${STAMP}`, null)
    await page(`ch-b-kid-${STAMP}`, b0, { publish: false })
    // leaf C → false.
    const c0 = await page(`ch-c-${STAMP}`, null)

    const rows = await listBranch(db, fgaClient, { spaceId, parentId: null, subject: READER })
    const flag = new Map(rows.pages.map((p) => [p.id, (p as { hasChildren?: boolean }).hasChildren]))
    expect(flag.get(a), 'a visible child earns the chevron').toBe(true)
    expect(flag.get(b0), 'an invisible-only child must read as NO children').toBe(false)
    expect(flag.get(c0), 'a leaf draws no chevron').toBe(false)
  }, 300_000)

  it('the viewing-leaf list is derived from the model, not from memory', () => {
    // The model's `viewable` union. A tenth arm added to model.fga must fail THIS test until the
    // resolver reads it — pinning today's nine by name is how a new arm goes silently unread.
    const model = readFileSync(resolve(import.meta.dirname, '../../../../infra/openfga/model.fga'), 'utf8')
    // The page type's relation table. `viewable`'s arms are verbs, and each verb's DIRECT leaf sits one
    // or two defines down — so this walks the positive arms recursively. Positive only: everything
    // after `but not` is a subtraction (`restricted`, `trashed`) and reading it would ADD the arms
    // that make a page invisible. Cross-type arms (`x from space`, `[user:*]`) are not direct page
    // leaves and stop the walk.
    const defines = new Map<string, string>()
    for (const l of model.split('\n')) {
      const m = l.match(/^\s*define ([a-z_]+):\s*(.+)$/)
      if (m && !defines.has(m[1]!)) defines.set(m[1]!, m[2]!)
    }
    const leaves = new Set<string>()
    const seen = new Set<string>()
    const walk = (rel: string): void => {
      if (seen.has(rel)) return
      seen.add(rel)
      const body = defines.get(rel)
      if (!body) return
      const positive = body.split('but not')[0]!
      for (const arm of positive.split(/\bor\b|\band\b/)) {
        const t = arm.trim()
        if (!t || t.startsWith('[')) continue          // direct-type lists ([user:*] …) are not verb leaves
        if (t.includes(' from ')) continue             // cross-type: not a page-direct leaf
        const name = t.match(/^([a-z_]+)$/)?.[1]
        if (!name) continue
        if (name.endsWith('_direct') || name === 'moderate') leaves.add(name)
        else walk(name)
      }
    }
    walk('viewable')
    expect(leaves.size, 'the walk found nothing — the model changed shape, rewire it').toBeGreaterThan(4)
    expect(leaves, 'the model grew a viewing leaf the placeholder resolver does not read')
      .toEqual(new Set(TREE_VIEW_LEAVES))
  })
})

// #903 / ADR-220 §13: the guest whole-space read no longer runs a `view` Check (and a badge read) on
// every page in the space to show `GUEST_TREE_CAP` rows — `listPagesGuestBounded` walks the tree
// closure in DFS pre-order, one branch at a time, and stops confirming once it has enough VISIBLE
// pages. Building a fixture past the shipped cap (500) would cost minutes (see #623's own note), so
// these pins call the exported function directly with a small `cap` override — the SAME code path the
// route runs, exercised against a fixture cheap enough for every commit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, listPagesGuestBounded, listBranch } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

// ADR-220 §13's own warning, restated by #903 design-review "a pin that measures only `view`
// Checks will report success while the reads still scale." A count-based wrapper around the REAL fga
// client (delegating every call, never faking a verdict) so a pin can assert the cost — not just the
// returned shape — stays proportional to `cap`, not to the size of the space.
function countingFga(real: OpenFgaClient): { fga: OpenFgaClient; checkedIds: () => number; readCalls: () => number } {
  // A plain object spread of `real` copies only OWN properties — the SDK client's methods (`check`,
  // `batchCheck`, `read`, ...) live on its prototype, so `{...real}` silently produces an object with
  // NONE of them (measured: the first version of this wrapper threw "fga.check is not a function"). A
  // Proxy delegates every OTHER property/method to `real` untouched, so `checkRelation`'s own `check`
  // call (the root-gate) still reaches the real store.
  let checked = 0, reads = 0
  const fga = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'batchCheck') {
        return (...args: Parameters<OpenFgaClient['batchCheck']>) => {
          checked += args[0]?.checks?.length ?? 0
          return target.batchCheck(...args)
        }
      }
      if (prop === 'read') {
        return (...args: Parameters<OpenFgaClient['read']>) => {
          reads += 1
          return target.read(...args)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { fga, checkedIds: () => checked, readCalls: () => reads }
}

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const LINK = `gcc903-${STAMP}`

let tenant: Tenant, db: TenantDb
let space: string
const ids: Record<string, string> = {}

async function makePage(title: string, parentId: string | null, visible: boolean) {
  const id = (await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId: space, userId: 'dev-user', title, parentId,
  })).id
  await admin`UPDATE pages SET published_md = 'b', published_at = now() WHERE id = ${id}`
  if (visible) {
    await writeTuples(fgaClient, [{ user: `space:${space}`, relation: 'space', object: `page:${id}` }])
  }
  ids[title] = id
  return id
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  space = (await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `gcc903-${STAMP}`,
  })).id
  await writeTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: 'viewer', object: `space:${space}` }])

  // Tree shape (DFS pre-order): root1, root1-child1, root1-child2, root2(invisible child C), root3
  const root1 = await makePage('root1', null, true)
  await makePage('root1-child1', root1, true)
  await makePage('root1-child2', root1, true)
  const root2 = await makePage('root2', null, true)
  await makePage('root2-child-invisible', root2, false) // NOT granted `space` — invisible to the guest
  await makePage('root3', null, true)

  // #903 design-review regression: root4 has FOUR children, in position order the first three
  // invisible and the fourth visible — beyond `listBranch`'s CHEVRON_PROBE_CAP (3). A recursion gated on
  // `hasChildren` (the chevron's own false-negative-tolerant display hint) never looks past the probe
  // window and drops the 4th child silently, with `truncated` still false.
  const root4 = await makePage('root4', null, true)
  await makePage('root4-child-invisible-1', root4, false)
  await makePage('root4-child-invisible-2', root4, false)
  await makePage('root4-child-invisible-3', root4, false)
  await makePage('root4-child-VISIBLE-4th', root4, true)
}, 300_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: 'viewer', object: `space:${space}` }]).catch(() => {})
  await admin`DELETE FROM pages WHERE space_id = ${space}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end({ timeout: 5 }); await admin.end()
}, 300_000)

const subject = `share_link:${LINK}`
const ctx = { current_time: new Date().toISOString() }

describe('#903 / ADR-220 §13: closure-bounded guest tree', () => {
  it('under cap: every visible page returned, none truncated', async () => {
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, tenantId: tenant.id, subject, context: ctx, cap: 50 })
    expect(out.truncated).toBe(false)
    expect(out.pages.map((p) => p.title)).toEqual([
      'root1', 'root1-child1', 'root1-child2', 'root2', 'root3', 'root4', 'root4-child-VISIBLE-4th',
    ])
  })

  it('DFS pre-order: a root\'s whole subtree precedes the next root — not flat position order', async () => {
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, tenantId: tenant.id, subject, context: ctx, cap: 50 })
    const order = out.pages.map((p) => p.title)
    expect(order.indexOf('root1-child2'), 'root1 subtree finishes before root2 starts')
      .toBeLessThan(order.indexOf('root2'))
  })

  it('an invisible child never appears and does not consume closure budget', async () => {
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, tenantId: tenant.id, subject, context: ctx, cap: 50 })
    expect(out.pages.some((p) => p.title === 'root2-child-invisible')).toBe(false)
    // 7 visible pages total — the invisible children (under root2 and root4) are not among them and did
    // not eat a slot that would otherwise have shown a later root.
    expect(out.pages).toHaveLength(7)
  })

  it('exactly at the cap: NOT truncated (a flat length compare would get this wrong)', async () => {
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, tenantId: tenant.id, subject, context: ctx, cap: 7 })
    expect(out.pages).toHaveLength(7)
    expect(out.truncated, 'nothing past the 7th visible page exists — this is not a cut').toBe(false)
  })

  it('#903 design-review regression: a visible 4th child beyond the CHEVRON_PROBE_CAP is not dropped', async () => {
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, tenantId: tenant.id, subject, context: ctx, cap: 50 })
    expect(out.pages.some((p) => p.title === 'root4-child-VISIBLE-4th'), 'the 4th (visible) child was silently dropped').toBe(true)
    expect(out.truncated, 'nothing was cut for budget reasons here — this page was just never found').toBe(false)
  })

  it('one past the cap: truncated, and the ancestor-inclusion invariant holds', async () => {
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, tenantId: tenant.id, subject, context: ctx, cap: 3 })
    expect(out.truncated).toBe(true)
    expect(out.pages.map((p) => p.title)).toEqual(['root1', 'root1-child1', 'root1-child2'])
    const byId = new Map(out.pages.map((p) => [p.id, p]))
    for (const p of out.pages) {
      if (p.parentId != null) expect(byId.has(p.parentId), `${p.title}'s parent is in the same response`).toBe(true)
    }
  })

  it('truncation mid-subtree still emits the ancestors that were already found', async () => {
    // cap=1 stops right after root1 itself — root1's children never get pushed, so the closure never
    // claims to have shown a page without its parent.
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, tenantId: tenant.id, subject, context: ctx, cap: 1 })
    expect(out.truncated).toBe(true)
    expect(out.pages.map((p) => p.title)).toEqual(['root1'])
  })
})

// #903 design-review, second finding: the earlier pins above measure only the RETURNED shape —
// they pass unchanged against the pre-#903 `listPages` (confirm everything) + slice(cap) implementation
// this ticket exists to replace, because neither the `view` Check count nor the badge `read` count was
// ever asserted. ADR-220 §13's own closing warning: "a pin that measures only view Checks will report
// success while the reads still scale... count both." This block does.
describe('#903 / ADR-220 §13: the FGA cost itself is bounded by cap, not by space size', () => {
  const driver2 = new LogicalSearchDriver()
  const STAMP2 = `${Date.now().toString(36)}z`
  const LINK2 = `gcc903cost-${STAMP2}`
  let tenant2: Tenant, db2: TenantDb, space2: string
  const CAP = 5
  const AFTER_CAP_SIBLINGS = 40 // never reached once cap is exhausted inside the FIRST root's children

  beforeAll(async () => {
    tenant2 = (await new TenantRegistry(pool).findBySlug('dev'))!
    db2 = await acquireTenantDb(tenant2)
    space2 = (await createSpace(db2, fgaClient, {
      tenantId: tenant2.id, userId: 'dev-user', plan: tenant2.plan, name: `gcc903cost-${STAMP2}`,
    })).id
    await writeTuples(fgaClient, [{ user: `share_link:${LINK2}`, relation: 'viewer', object: `space:${space2}` }])
    const visible = async (title: string, parentId: string | null) => {
      const id = (await createPage(db2, fgaClient, driver2, {
        tenantId: tenant2.id, spaceId: space2, userId: 'dev-user', title, parentId,
      })).id
      await pool`UPDATE pages SET published_md = 'b', published_at = now() WHERE id = ${id}`
      await writeTuples(fgaClient, [{ user: `space:${space2}`, relation: 'space', object: `page:${id}` }])
      return id
    }
    // firstRoot alone has CAP+1 visible children — the walk exhausts its budget inside this ONE branch,
    // so it never even fetches secondRoot's branch, let alone its 40 children.
    const firstRoot = await visible('firstRoot', null)
    for (let i = 0; i < CAP + 1; i++) await visible(`firstRoot-child-${i}`, firstRoot)
    const secondRoot = await visible('secondRoot', null)
    for (let i = 0; i < AFTER_CAP_SIBLINGS; i++) await visible(`secondRoot-child-${i}`, secondRoot)
  }, 300_000)

  afterAll(async () => {
    await deleteTuples(fgaClient, [{ user: `share_link:${LINK2}`, relation: 'viewer', object: `space:${space2}` }]).catch(() => {})
    await pool`DELETE FROM pages WHERE space_id = ${space2}`.catch(() => {})
    await deleteSpace(db2, fgaClient, driver2, { tenantId: tenant2.id, spaceId: space2, userId: 'dev-user' }).catch(() => {})
    await db2.release()
  }, 300_000)

  it('view Checks and badge reads both stay near cap, nowhere near the 42 visible pages that exist', async () => {
    const { fga, checkedIds, readCalls } = countingFga(fgaClient)
    const out = await listPagesGuestBounded(db2, fga, {
      spaceId: space2, tenantId: tenant2.id, subject: `share_link:${LINK2}`, context: { current_time: new Date().toISOString() }, cap: CAP,
    })
    expect(out.truncated, 'the budget really was exhausted inside firstRoot').toBe(true)
    expect(out.pages).toHaveLength(CAP)
    expect(out.pages.some((p) => p.title.startsWith('secondRoot')), 'secondRoot was never reached').toBe(false)
    // Generous slack: each `listBranch` call badges/checks its WHOLE returned page (bounded by that
    // one branch's own size, not by the space) — the root branch returns both roots (2), and
    // firstRoot's children branch returns all 6 in one call even though the walk only pushes 4 of them
    // before hitting cap. That per-branch batching is real, bounded overhead (measured here at 8), not
    // a defect — but it is nowhere near the 42 visible pages in the space, or the ~46 a full-space
    // confirm (the pre-#903 shape) would run.
    expect(checkedIds(), `only ${checkedIds()} ids checked`).toBeLessThan(CAP + 15)
    expect(readCalls(), `only ${readCalls()} badge reads`).toBeLessThanOrEqual(CAP + 10)
  })
})

// #903 / ADR-220 §14: a VISIBLE page sitting under an INVISIBLE ancestor. §13(a)'s closure walk
// can never descend into a parent it is not allowed to view, so a page like this was silently dropped —
// a regression from the pre-#903 flat `listPages` behaviour `GuestSidebar`'s `buildTree` re-roots for
// (the comment "a permitted page is never orphaned out of the tree" is still in that file, describing a
// promise the server stopped keeping). §14 restores it via `resolveTreePlaceholders`'s path 2 (descend),
// volunteered flat in this same response.
describe('#903 / ADR-220 §14: a visible page behind an invisible ancestor is still found', () => {
  const driver3 = new LogicalSearchDriver()
  const STAMP3 = `${Date.now().toString(36)}y`
  const LINK3 = `gcc903ph-${STAMP3}`
  let tenant3: Tenant, db3: TenantDb, space3: string
  const ids3: Record<string, string> = {}

  async function page3(title: string, parentId: string | null, visible: boolean) {
    const id = (await createPage(db3, fgaClient, driver3, {
      tenantId: tenant3.id, spaceId: space3, userId: 'dev-user', title, parentId,
    })).id
    await pool`UPDATE pages SET published_md = 'b', published_at = now() WHERE id = ${id}`
    if (visible) await writeTuples(fgaClient, [{ user: `space:${space3}`, relation: 'space', object: `page:${id}` }])
    ids3[title] = id
    return id
  }

  beforeAll(async () => {
    tenant3 = (await new TenantRegistry(pool).findBySlug('dev'))!
    db3 = await acquireTenantDb(tenant3)
    space3 = (await createSpace(db3, fgaClient, {
      tenantId: tenant3.id, userId: 'dev-user', plan: tenant3.plan, name: `gcc903ph-${STAMP3}`,
    })).id
    await writeTuples(fgaClient, [{ user: `share_link:${LINK3}`, relation: 'viewer', object: `space:${space3}` }])

    // the exact case: an invisible ROOT (never granted `space`) whose only child IS visible.
    const draftRoot = await page3('draftRoot', null, false)
    await page3('draftRoot-child-VISIBLE', draftRoot, true)

    // Two invisible layers deep, then a visible grandchild whose OWN child is visible too — proves
    // `descend` recurses through consecutive invisible nodes, and that a surfaced page re-enters the
    // NORMAL walk (its own child arrives via `listBranch`, not another `descend`).
    const deepA = await page3('deepA-invisible', null, false)
    const deepB = await page3('deepB-invisible', deepA, false)
    const deepC = await page3('deepC-VISIBLE', deepB, true)
    await page3('deepC-child-VISIBLE', deepC, true)

    // A control: an ordinary visible root, unaffected by any of the above.
    await page3('normalRoot', null, true)
  }, 300_000)

  afterAll(async () => {
    await deleteTuples(fgaClient, [{ user: `share_link:${LINK3}`, relation: 'viewer', object: `space:${space3}` }]).catch(() => {})
    await pool`DELETE FROM pages WHERE space_id = ${space3}`.catch(() => {})
    await deleteSpace(db3, fgaClient, driver3, { tenantId: tenant3.id, spaceId: space3, userId: 'dev-user' }).catch(() => {})
    await db3.release()
  }, 300_000)

  const subject3 = `share_link:${LINK3}`
  const ctx3 = { current_time: new Date().toISOString() }

  // §14 rev11 (owner ruling 2026-09-05): the surfaced page keeps its DEPTH. It arrives under an unnamed
  // anchor — the member mechanism's own `PlaceholderNode` — instead of flattened into the root list,
  // which is what the 2026-09-01 shipping form did (measured on a real share link: the page from inside
  // a hidden folder drew as a top-level row among the space's real roots).
  it('a visible child of an invisible ROOT arrives ANCHORED, not flattened into the root list', async () => {
    const out = await listPagesGuestBounded(db3, fgaClient, { spaceId: space3, tenantId: tenant3.id, subject: subject3, context: ctx3, cap: 50 })
    expect(out.pages.some((p) => p.title === 'draftRoot-child-VISIBLE'), 'never a top-level row').toBe(false)
    const anchor = out.placeholders.find((ph) => ph.pages.some((p) => p.title === 'draftRoot-child-VISIBLE'))
    expect(anchor, 'the page must appear under an anchor').toBeTruthy()
    // §4.5: the anchor is placed by the nearest VISIBLE ancestor — here the space root itself.
    expect(anchor!.under).toBeNull()
    expect(anchor!.parentToken).toBeNull()
    // §4.1: never the real (invisible) parent id — that IS the invisible page's id.
    expect((anchor!.pages.find((p) => p.title === 'draftRoot-child-VISIBLE') as { parentId?: unknown }).parentId).toBeNull()
  })

  it('an anchor carries no field of the invisible page it stands for', async () => {
    const out = await listPagesGuestBounded(db3, fgaClient, { spaceId: space3, tenantId: tenant3.id, subject: subject3, context: ctx3, cap: 50 })
    for (const ph of out.placeholders) {
      expect(Object.keys(ph).sort(), 'the anchor is a token, a placement and its pages — nothing else')
        .toEqual(['pages', 'parentToken', 'token', 'under'])
    }
    // The whole wire answer, not just the row arrays: an id reaching ANY field of it is a leak.
    const wire = JSON.stringify(out)
    const rows = [...out.pages, ...out.placeholders.flatMap((ph) => ph.pages)]
    for (const title of ['draftRoot', 'deepA-invisible', 'deepB-invisible']) {
      expect(wire.includes(ids3[title]!), `${title}'s id must not reach the wire`).toBe(false)
      // Titles are compared EXACTLY, not by substring: 'draftRoot' is a prefix of the visible child's
      // own title ('draftRoot-child-VISIBLE'), and a substring test reads that legitimate row as a leak.
      expect(rows.some((p) => p.title === title), `${title}'s title must not reach the wire`).toBe(false)
    }
  })

  it('a two-layer invisible chain nests as a CHAIN of anchors, and the surfaced page keeps its own child', async () => {
    const out = await listPagesGuestBounded(db3, fgaClient, { spaceId: space3, tenantId: tenant3.id, subject: subject3, context: ctx3, cap: 50 })
    const inner = out.placeholders.find((ph) => ph.pages.some((p) => p.title === 'deepC-VISIBLE'))
    expect(inner, 'the grandchild must be found').toBeTruthy()
    // Two invisible layers = two anchors, one inside the other — NOT one flattened anchor and not two
    // siblings, so the depth the reader sees matches the depth that is really there.
    expect(inner!.parentToken, 'the inner anchor hangs off the outer one').toBeTruthy()
    const outer = out.placeholders.find((ph) => ph.token === inner!.parentToken)
    expect(outer, 'the outer anchor rides the same response').toBeTruthy()
    expect(outer!.under, 'the outer anchor sits at the space root').toBeNull()
    expect(outer!.pages, 'the outer layer anchors nothing directly — it is a link in the chain').toHaveLength(0)
    // The surfaced page re-enters the NORMAL walk, so its own child is an ordinary visible-parented row
    // and needs no anchor of its own (§14: only the first hop out of invisible territory needs one).
    const grandchild = out.pages.find((p) => p.title === 'deepC-child-VISIBLE')
    expect(grandchild, 'the surfaced page re-enters the normal walk for its OWN children').toBeTruthy()
    expect(grandchild!.parentId).toBe(inner!.pages.find((p) => p.title === 'deepC-VISIBLE')!.id)
  })

  it('the cap counts pages surfaced under an anchor, not only top-level rows', async () => {
    // The fixture has ONE ordinary visible root and three pages that only exist behind anchors. With
    // `visible.length` as the counter (the pre-anchor arithmetic) the anchored rows are free and the cap
    // never trips: the space could draw an unbounded tree while the counter read one.
    const out = await listPagesGuestBounded(db3, fgaClient, { spaceId: space3, tenantId: tenant3.id, subject: subject3, context: ctx3, cap: 2 })
    const shown = out.pages.length + out.placeholders.reduce((n, ph) => n + ph.pages.length, 0)
    expect(shown, 'exactly the cap, counting anchored rows').toBe(2)
    expect(out.truncated, 'and it says so').toBe(true)
  })

  it('an anchor that ends up anchoring nothing is never emitted', async () => {
    // §4 ruling ②: a placeholder is drawn ONLY as an anchor. The cap above can cut a chain's pages away
    // after its anchors were minted; what is left must not announce a hidden node while showing nobody.
    for (const cap of [1, 2, 3, 50]) {
      const out = await listPagesGuestBounded(db3, fgaClient, { spaceId: space3, tenantId: tenant3.id, subject: subject3, context: ctx3, cap })
      for (const ph of out.placeholders) {
        const anchorsSomething = ph.pages.length > 0 || out.placeholders.some((x) => x.parentToken === ph.token)
        expect(anchorsSomething, `cap=${cap}: an empty anchor reached the wire`).toBe(true)
      }
    }
  })

  it('an ordinary visible root is unaffected', async () => {
    const out = await listPagesGuestBounded(db3, fgaClient, { spaceId: space3, tenantId: tenant3.id, subject: subject3, context: ctx3, cap: 50 })
    expect(out.pages.some((p) => p.title === 'normalRoot')).toBe(true)
    expect(out.placeholders.some((ph) => ph.pages.some((p) => p.title === 'normalRoot')),
      'a normally-parented page is never anchored').toBe(false)
  })

  it('a placeholder budget too small to reach a deep chain truncates loudly, not silently', async () => {
    // budget=1 lets the walk examine only the FIRST invisible seed it tries (root-level: draftRoot and
    // deepA-invisible are both root-level invisible seeds) before running out — whichever one it does
    // NOT reach must not be silently absent from a response that also claims completeness.
    const out = await listPagesGuestBounded(db3, fgaClient, {
      spaceId: space3, tenantId: tenant3.id, subject: subject3, context: ctx3, cap: 50, placeholderBudget: 1,
    })
    expect(out.truncated, 'the placeholder budget ran out — §6.2\'s loud-cap rule applies here too').toBe(true)
  })

  it('view Checks stay bounded by the placeholder budget, not by how deep the invisible chain runs', async () => {
    const { fga, checkedIds } = countingFga(fgaClient)
    const out = await listPagesGuestBounded(db3, fga, {
      spaceId: space3, tenantId: tenant3.id, subject: subject3, context: ctx3, cap: 50, placeholderBudget: 50,
    })
    expect(out.truncated).toBe(false)
    // 2 root-level branches (root, then normalRoot's siblings) + walking draftRoot-child-VISIBLE's own
    // (empty) branch + deepC-VISIBLE's + deepC-child-VISIBLE's — small and bounded, nowhere near a
    // space-wide scan.
    expect(checkedIds(), `only ${checkedIds()} ids checked`).toBeLessThan(30)
  })

  // `listBranch`'s new `onInvisible` callback (#903 §14) is a side channel specifically so `/pages/branch`
  // — which returns this function's result DIRECTLY to the wire for both members and guests — cannot leak
  // the invisible-children complement by a caller forgetting to strip a response field. This pin measures
  // the actual return object's own keys, not the type, since a type-level guarantee cannot catch a field
  // added to the object at runtime.
  it('listBranch never puts the invisible complement on its own return value', async () => {
    let fired = false
    const result = await listBranch(db3, fgaClient, {
      spaceId: space3, parentId: null, subject: subject3, context: ctx3,
      onInvisible: (ids) => { fired = ids.length > 0 },
    })
    expect(fired, 'the fixture root has an invisible child (deepA-invisible) — the callback must see it').toBe(true)
    expect(Object.keys(result).sort()).toEqual(['nextCursor', 'pages', 'restarted'])
  })
})

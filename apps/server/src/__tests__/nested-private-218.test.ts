// #218 / ADR-103 — nested-page (folder) private inheritance + direct-grant cascade. THE anti-test suite for
// the atomic authz flip. Runs against the real OpenFGA engine (security boundary — no mocks). Two layers:
//
//   1. DSL semantics (this is where the model flip lives): a tree of `page:*#parent@page:*` tuples proves the
//      cascade rules directly — direct grants flow DOWN the parent chain, public (user:*) and space inheritance
//      do NOT, private flows DOWN (monotonic), and the monotonic deny (`restricted`, per-page, non-inherited)
//      wins over an inherited grant for BOTH view and edit.
//   2. Write-boundary (product code): setPagePrivate over a subtree + reparent-under-private strip the DIRECT
//      public grant the model cannot subtract, and doc-builder excludes an inherited-private child from search.
//
// The build of the tree: space:S ─ P(root) ─ M(mid) ─ L(leaf). Space membership reaches P via `space from`, then
// the cascade (or its absence) is what these tests pin.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import postgres from 'postgres'
import { fgaClient, check, checkRelation, writeTuples, deleteTuples } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { LogicalSearchDriver, buildSearchDoc } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, setPagePrivate, movePage } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const now = () => new Date().toISOString()
const page = (id: string) => ({ type: 'page' as const, id })

// ── Layer 1: pure DSL cascade semantics ───────────────────────────────────
// A synthetic tree wired with explicit `parent` tuples (no DB rows needed — the model is what's under test).
// space:S218 grants dev-user manager (so it can view/edit/manage P by space inheritance). The tree is
// P → M → L (L is P's grandchild). All tuples are torn down after each test that mutates them.
describe('#218 / ADR-103 — DSL cascade semantics', () => {
  const S = 'space:s218'
  const P = 'page:p218_root'
  const M = 'page:p218_mid'
  const L = 'page:p218_leaf'
  const SIB = 'page:p218_sibling' // a second child of P, to prove per-page (non-cascading) scoping
  // The skeleton: space link on the root + parent chain. Space membership flows to P; P→M→L is the chain.
  // All four pages are PUBLISHED here (space link + `published` marker pair) — the folder grant-cascade is
  // `*_from_parent AND published`, so a receiving page must be published to inherit. The DRAFT-GATE describe
  // below covers the unpublished case (no published marker → no inheritance). published marker is a PAIR so it
  // matches both user and share_link inheritors.
  const publishedMarkers = (obj: string) => [
    { user: 'user:*', relation: 'published', object: obj },
    { user: 'share_link:*', relation: 'published', object: obj },
  ]
  const skeleton = [
    { user: 'user:dev-user218', relation: 'manager', object: S },
    { user: S, relation: 'space', object: P },
    { user: S, relation: 'space', object: M },
    { user: S, relation: 'space', object: L },
    { user: S, relation: 'space', object: SIB },
    { user: P, relation: 'parent', object: M },
    { user: M, relation: 'parent', object: L },
    { user: P, relation: 'parent', object: SIB },
    ...publishedMarkers(P), ...publishedMarkers(M), ...publishedMarkers(L), ...publishedMarkers(SIB),
  ]
  beforeAll(async () => { await writeTuples(fgaClient, skeleton) }, 60_000)
  afterAll(async () => { for (const t of skeleton) await deleteTuples(fgaClient, [t]).catch(() => {}) }, 60_000)

  describe('direct grants cascade DOWN the parent chain', () => {
    const alice = (rel: string, obj: string) => ({ user: 'user:alice218', relation: rel, object: obj })
    const clean = async () => {
      for (const o of [P, M, L, SIB]) for (const r of ['view_direct', 'edit_direct', 'manage_direct', 'restricted', 'private'])
        await deleteTuples(fgaClient, [{ user: 'user:alice218', relation: r, object: o }]).catch(() => {})
      await deleteTuples(fgaClient, [{ user: 'user:*', relation: 'view_base', object: P }]).catch(() => {})
    }
    beforeEach(clean); afterEach(clean)

    it('a view_direct grant on the ROOT reaches child AND grandchild (view_base_from_parent recurses)', async () => {
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_leaf'))).toBe(false) // baseline: no access
      await writeTuples(fgaClient, [alice('view_direct', P)])
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_root'))).toBe(true)
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_mid'))).toBe(true) // ← cascaded 1 level
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_leaf'))).toBe(true) // ← cascaded 2 levels
    })

    it('an edit_direct grant on the root cascades edit to the whole subtree', async () => {
      await writeTuples(fgaClient, [alice('edit_direct', P)])
      expect(await check(fgaClient, 'user:alice218', 'edit', page('p218_mid'))).toBe(true)
      expect(await check(fgaClient, 'user:alice218', 'edit', page('p218_leaf'))).toBe(true)
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_leaf'))).toBe(true) // edit ⇒ can also view
    })

    it('a manage_direct grant on the root cascades manage down the chain', async () => {
      await writeTuples(fgaClient, [alice('manage_direct', P)])
      expect(await check(fgaClient, 'user:alice218', 'manage', page('p218_mid'))).toBe(true)
      expect(await check(fgaClient, 'user:alice218', 'manage', page('p218_leaf'))).toBe(true)
    })

    it('a grant on the MIDDLE reaches the leaf but NOT the root or a sibling (downward-only)', async () => {
      await writeTuples(fgaClient, [alice('view_direct', M)])
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_leaf'))).toBe(true) // below M → yes
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_root'))).toBe(false) // above M → no
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_sibling'))).toBe(false) // not under M → no
    })

    it('PUBLIC (user:* on view_base) does NOT cascade — a public root keeps its children member-only (#100)', async () => {
      await writeTuples(fgaClient, [{ user: 'user:*', relation: 'view_base', object: P }])
      expect(await check(fgaClient, 'user:nobody218', 'view', page('p218_root'))).toBe(true) // root is public
      expect(await check(fgaClient, 'user:nobody218', 'view', page('p218_mid'))).toBe(false) // child NOT public
      expect(await check(fgaClient, 'user:nobody218', 'view', page('p218_leaf'))).toBe(false)
    })
  })

  describe('private cascades DOWN (monotonic, downward-only)', () => {
    const privMarker = (obj: string) => [
      { user: 'user:*', relation: 'private', object: obj },
      { user: 'share_link:*', relation: 'private', object: obj },
    ]
    const clean = async () => {
      for (const o of [P, M, L]) for (const t of privMarker(o)) await deleteTuples(fgaClient, [t]).catch(() => {})
    }
    beforeEach(clean); afterEach(clean)

    it('a private marker on the ROOT cuts space inheritance for the ENTIRE subtree (inherited private → 404)', async () => {
      // baseline: the space manager views the whole tree via space inheritance.
      expect(await check(fgaClient, 'user:dev-user218', 'view', page('p218_root'))).toBe(true)
      expect(await check(fgaClient, 'user:dev-user218', 'view', page('p218_leaf'))).toBe(true)
      await writeTuples(fgaClient, privMarker(P)) // mark ONLY the root private
      // the whole subtree loses the space-inherited path — `private from parent` reaches mid + leaf.
      expect(await check(fgaClient, 'user:dev-user218', 'view', page('p218_root'))).toBe(false)
      expect(await check(fgaClient, 'user:dev-user218', 'view', page('p218_mid'))).toBe(false) // ← inherited private
      expect(await check(fgaClient, 'user:dev-user218', 'view', page('p218_leaf'))).toBe(false)
      expect(await check(fgaClient, 'user:dev-user218', 'edit', page('p218_leaf'))).toBe(false)
      expect(await check(fgaClient, 'user:dev-user218', 'manage', page('p218_leaf'))).toBe(false)
    })

    it('the probe used by the write/search paths sees inherited private on a child (checkRelation "private")', async () => {
      await writeTuples(fgaClient, privMarker(P))
      // doc-builder/movePage read `private` for an arbitrary probe principal to detect effective privacy.
      expect(await checkRelation(fgaClient, 'user:__probe__', 'private', page('p218_leaf'))).toBe(true)
      expect(await checkRelation(fgaClient, 'user:__probe__', 'private', page('p218_sibling'))).toBe(true)
    })

    it('a private child KEEPS an explicit direct grant (allow list survives inherited private)', async () => {
      await writeTuples(fgaClient, [...privMarker(P), { user: 'user:allowed218', relation: 'view_direct', object: L }])
      try {
        expect(await check(fgaClient, 'user:allowed218', 'view', page('p218_leaf'))).toBe(true) // explicit grant survives
        expect(await check(fgaClient, 'user:dev-user218', 'view', page('p218_leaf'))).toBe(false) // space path still cut
      } finally {
        await deleteTuples(fgaClient, [{ user: 'user:allowed218', relation: 'view_direct', object: L }]).catch(() => {})
      }
    })
  })

  describe('monotonic deny (restricted) — per-page, NON-inherited, wins over an inherited grant', () => {
    const alice = (rel: string, obj: string) => ({ user: 'user:alice218', relation: rel, object: obj })
    const clean = async () => {
      for (const o of [P, M, L]) for (const r of ['view_direct', 'edit_direct', 'manage_direct', 'restricted'])
        await deleteTuples(fgaClient, [{ user: 'user:alice218', relation: r, object: o }]).catch(() => {})
    }
    beforeEach(clean); afterEach(clean)

    it('restrict on a child WINS over a grant inherited from the root (view denied at that child only)', async () => {
      await writeTuples(fgaClient, [alice('view_direct', P), alice('restricted', M)])
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_root'))).toBe(true) // granted at root
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_mid'))).toBe(false) // ← restricted here
      // restricted is NOT inherited, so the leaf BELOW the restricted mid still inherits the root grant.
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_leaf'))).toBe(true)
    })

    it('restrict WINS over an inherited EDIT grant too (A5-5 — edit_permitted subtracts restricted)', async () => {
      await writeTuples(fgaClient, [alice('edit_direct', P), alice('restricted', M)])
      expect(await check(fgaClient, 'user:alice218', 'edit', page('p218_mid'))).toBe(false) // edit denied at mid
      expect(await check(fgaClient, 'user:alice218', 'edit', page('p218_leaf'))).toBe(true) // still inherits below
    })

    it('a restricted MANAGER can still edit (edit = manage OR edit_permitted; manage is not subtracted)', async () => {
      // manage bypasses the deny — a manager keeps edit even while restricted (deny scopes to the grant paths,
      // not to management). This pins the `edit: manage or edit_permitted` shape.
      await writeTuples(fgaClient, [alice('manage_direct', M), alice('restricted', M)])
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_mid'))).toBe(false) // view IS subtracted
      expect(await check(fgaClient, 'user:alice218', 'edit', page('p218_mid'))).toBe(true) // manage ⇒ edit survives
    })
  })

  describe('share_link (folder link) cascades and single-tuple revoke', () => {
    const LINK = 'share_link:folder218'
    const clean = async () => {
      for (const o of [P, M, L]) for (const r of ['view_direct', 'edit_direct', 'restricted'])
        await deleteTuples(fgaClient, [{ user: LINK, relation: r, object: o }]).catch(() => {})
    }
    beforeEach(clean); afterEach(clean)

    it('a view link on the folder ROOT reaches every descendant (folder-share cascade)', async () => {
      await writeTuples(fgaClient, [{ user: LINK, relation: 'view_direct', object: P }])
      expect(await check(fgaClient, LINK, 'view', page('p218_mid'), { current_time: now() })).toBe(true)
      expect(await check(fgaClient, LINK, 'view', page('p218_leaf'), { current_time: now() })).toBe(true)
    })

    it('deleting the ONE folder-link tuple revokes the whole subtree (1 share_link = 1 tuple to revoke)', async () => {
      const t = { user: LINK, relation: 'view_direct', object: P }
      await writeTuples(fgaClient, [t])
      expect(await check(fgaClient, LINK, 'view', page('p218_leaf'), { current_time: now() })).toBe(true)
      await deleteTuples(fgaClient, [t]) // the single revoke op
      expect(await check(fgaClient, LINK, 'view', page('p218_leaf'), { current_time: now() })).toBe(false)
    })

    it('a folder-link guest can be EXCLUDED from a specific child via restricted (share_link on the deny list)', async () => {
      await writeTuples(fgaClient, [
        { user: LINK, relation: 'view_direct', object: P },
        { user: LINK, relation: 'restricted', object: M },
      ])
      expect(await check(fgaClient, LINK, 'view', page('p218_root'), { current_time: now() })).toBe(true)
      expect(await check(fgaClient, LINK, 'view', page('p218_mid'), { current_time: now() })).toBe(false) // ← denied
      expect(await check(fgaClient, LINK, 'view', page('p218_leaf'), { current_time: now() })).toBe(true) // below, still in
    })
  })

  // DRAFT GATE (ADR-103 addendum): the folder grant-cascade is `*_from_parent AND published`. An UNPUBLISHED
  // draft (no `published` marker) under a granted folder stays creator-only (Phase-4 visibility gate). The
  // `*_from_parent` recursion is still STRUCTURAL (ungated), so a grant propagates DOWN through a draft
  // intermediate to a PUBLISHED descendant — only the receiving page's published state gates the grant.
  describe('draft gate — folder grants reach PUBLISHED children only, never an unpublished draft', () => {
    const alice = (rel: string, obj: string) => ({ user: 'user:alice218', relation: rel, object: obj })
    const pub = (obj: string) => [
      { user: 'user:*', relation: 'published', object: obj },
      { user: 'share_link:*', relation: 'published', object: obj },
    ]
    const clean = async () => {
      for (const o of [P, M, L]) {
        for (const r of ['view_direct', 'edit_direct'])
          await deleteTuples(fgaClient, [{ user: 'user:alice218', relation: r, object: o }]).catch(() => {})
        for (const t of pub(o)) await deleteTuples(fgaClient, [t]).catch(() => {})
      }
    }
    // These tests toggle the published markers themselves, so start from a clean slate (skeleton's markers are
    // deleted here and restored in afterEach). Re-add the skeleton's markers after each test.
    beforeEach(async () => { await clean(); for (const o of [P, M, L]) for (const t of pub(o)) await deleteTuples(fgaClient, [t]).catch(() => {}) })
    afterEach(async () => { await clean(); await writeTuples(fgaClient, [...pub(P), ...pub(M), ...pub(L)]) })

    it('a folder grant does NOT reach an UNPUBLISHED draft child (creator-only until publish)', async () => {
      // P is published, M is an UNPUBLISHED draft (no published marker). Grant alice view on P.
      await writeTuples(fgaClient, [...pub(P), alice('view_direct', P)])
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_root'))).toBe(true) // P published + granted
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_mid'))).toBe(false) // ← M is a draft → NO inherit
    })

    it('PUBLISHING the draft child releases the inherited grant (draft → published flips access on)', async () => {
      await writeTuples(fgaClient, [...pub(P), alice('view_direct', P)])
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_mid'))).toBe(false) // draft: withheld
      await writeTuples(fgaClient, pub(M)) // publish M
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_mid'))).toBe(true) // ← now inherits
    })

    it('a grant PROPAGATES through a DRAFT intermediate to a PUBLISHED grandchild (structural walk, per-page gate)', async () => {
      // P published + granted; M is a DRAFT; L is PUBLISHED. The recursion is ungated so P's grant reaches L
      // structurally, and L's published state lets it RECEIVE the grant — while the draft M in between does not.
      await writeTuples(fgaClient, [...pub(P), ...pub(L), alice('view_direct', P)])
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_mid'))).toBe(false) // draft middle: withheld
      expect(await check(fgaClient, 'user:alice218', 'view', page('p218_leaf'))).toBe(true) // ← published leaf inherits
    })

    it('an EDIT folder grant is gated by published too (draft child is not editable by a folder editor)', async () => {
      await writeTuples(fgaClient, [...pub(P), alice('edit_direct', P)])
      expect(await check(fgaClient, 'user:alice218', 'edit', page('p218_mid'))).toBe(false) // draft: no inherited edit
      await writeTuples(fgaClient, pub(M))
      expect(await check(fgaClient, 'user:alice218', 'edit', page('p218_mid'))).toBe(true) // published: inherits edit
    })

    it('a folder SHARE-LINK is gated by published too (a link guest cannot reach a draft child)', async () => {
      // the published marker PAIR includes share_link:* precisely so a folder LINK guest is gated the same way
      // as a member — a lone user:* marker would leak drafts to link guests (or a lone share_link:* to members).
      const LINK = 'share_link:draftgate218'
      const t = { user: LINK, relation: 'view_direct', object: P }
      try {
        await writeTuples(fgaClient, [...pub(P), t])
        expect(await check(fgaClient, LINK, 'view', page('p218_root'), { current_time: now() })).toBe(true)
        expect(await check(fgaClient, LINK, 'view', page('p218_mid'), { current_time: now() })).toBe(false) // draft: withheld
        await writeTuples(fgaClient, pub(M))
        expect(await check(fgaClient, LINK, 'view', page('p218_mid'), { current_time: now() })).toBe(true) // published: inherits
      } finally {
        await deleteTuples(fgaClient, [t]).catch(() => {})
      }
    })

    it('private CASCADES to a draft child (private is NOT published-gated — the safe, more-restrictive direction)', async () => {
      // The published gate narrows GRANTS only; private (a restriction) still reaches an unpublished draft, so a
      // draft under a private folder is private-flagged. Safe: private only ever removes access.
      const markers = [
        { user: 'user:*', relation: 'private', object: P },
        { user: 'share_link:*', relation: 'private', object: P },
      ]
      try {
        await writeTuples(fgaClient, [...pub(P), ...markers]) // P private+published; M stays a draft (no marker)
        expect(await checkRelation(fgaClient, 'user:__p__', 'private', page('p218_mid'))).toBe(true) // draft inherits private
      } finally {
        for (const m of markers) await deleteTuples(fgaClient, [m]).catch(() => {})
      }
    })
  })
})

// ── Layer 2: write-boundary + search (product code) ───────────────────────
// The model cannot subtract the DIRECT public grant (user:* on view_base). setPagePrivate/movePage strip it
// across the subtree; doc-builder reflects inherited private in the search index. Real Postgres + OpenFGA.
describe('#218 / ADR-103 — write boundary + search (product)', () => {
  const driver = new LogicalSearchDriver()
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
  let tenant: Tenant
  let db: TenantDb
  let spaceId: string
  const ids: string[] = []

  async function mkPage(title: string, parentId?: string): Promise<string> {
    const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId })
    ids.push(p.id)
    return p.id
  }

  beforeAll(async () => {
    const registry = new TenantRegistry(pool)
    tenant = (await registry.findBySlug('dev'))!
    db = await acquireTenantDb(tenant)
    const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'nested-218-space' })
    spaceId = space.id
  }, 60_000)

  afterAll(async () => {
    for (const id of ids.reverse()) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
    await db.release()
    await pool.end()
    await adminPool.end()
  }, 60_000)

  it('setPagePrivate on a FOLDER marks the whole subtree private (one root marker) and cuts a child from space members', async () => {
    const root = await mkPage('Folder Root')
    const child = await mkPage('Folder Child', root)
    const grandchild = await mkPage('Folder Grandchild', child)
    // Release space inheritance on the subtree (createPage leaves a page a draft with NO page#space link — the
    // Phase-4 visibility gate; publish writes it). Simulate the published state so space members inherit view.
    const spaceLinks = [root, child, grandchild].map((id) => ({ user: `space:${spaceId}`, relation: 'space', object: `page:${id}` }))
    // a space member (grant view on the space) can view all three before privatization.
    await writeTuples(fgaClient, [...spaceLinks, { user: 'user:member218', relation: 'viewer', object: `space:${spaceId}` }])
    try {
      expect(await check(fgaClient, 'user:member218', 'view', page(grandchild))).toBe(true)
      await setPagePrivate(db, fgaClient, driver, { pageId: root, userId: 'dev-user', tenantId: tenant.id })
      // the marker sits on the root only; `private from parent` carries it to child + grandchild.
      expect(await checkRelation(fgaClient, 'user:__p__', 'private', page(child))).toBe(true)
      expect(await checkRelation(fgaClient, 'user:__p__', 'private', page(grandchild))).toBe(true)
      expect(await check(fgaClient, 'user:member218', 'view', page(grandchild))).toBe(false) // space member cut
      expect(await check(fgaClient, 'user:dev-user', 'view', page(grandchild))).toBe(true) // creator (manage_direct) keeps it
    } finally {
      await deleteTuples(fgaClient, [...spaceLinks, { user: 'user:member218', relation: 'viewer', object: `space:${spaceId}` }]).catch(() => {})
    }
  })

  it('reparenting a PUBLIC child under a PRIVATE folder strips its direct public grant (public⊥private boundary)', async () => {
    const privRoot = await mkPage('Private Root')
    await setPagePrivate(db, fgaClient, driver, { pageId: privRoot, userId: 'dev-user', tenantId: tenant.id })
    const pub = await mkPage('Public Page') // top-level, made public
    await writeTuples(fgaClient, [{ user: 'user:*', relation: 'view_base', object: `page:${pub}` }])
    expect(await check(fgaClient, 'user:anon218', 'view', page(pub))).toBe(true) // public before the move
    // move the public page UNDER the private folder → the boundary must strip the user:* grant.
    await movePage(db, fgaClient, driver, { pageId: pub, parentId: privRoot, afterId: null, userId: 'dev-user' })
    expect(await check(fgaClient, 'user:anon218', 'view', page(pub))).toBe(false) // public grant stripped
    expect(await checkRelation(fgaClient, 'user:__p__', 'private', page(pub))).toBe(true) // now inherits private
  })

  it('doc-builder: an inherited-private child is NOT is_public in the search doc (search stage-1 exclusion)', async () => {
    const root = await mkPage('Search Root')
    const child = await mkPage('Search Child', root)
    // publish the child + make the SUBTREE public, then privatize the root → child must flip to non-public.
    await adminPool`UPDATE pages SET published_md = ${'child body'}, published_at = now() WHERE id = ${child}`
    await writeTuples(fgaClient, [{ user: 'user:*', relation: 'view_base', object: `page:${child}` }])
    const before = await buildSearchDoc(pool, fgaClient, child, tenant.id)
    expect(before?.isPublic).toBe(true)
    await setPagePrivate(db, fgaClient, driver, { pageId: root, userId: 'dev-user', tenantId: tenant.id })
    const after = await buildSearchDoc(pool, fgaClient, child, tenant.id)
    expect(after?.isPublic).toBe(false) // inherited private overrides the (stale) direct public grant in the doc
  })
})

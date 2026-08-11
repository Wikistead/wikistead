import { randomUUID } from 'node:crypto'
import type { OpenFgaClient } from '@openfga/sdk'
import { filterAuthorized, currentAuthzScope } from '@wikistead/authz'
import type { TenantDb } from '../db/index.js'
import { groupGrantee } from '../auth/group-sync.js'

// #623 / ADR-220 §4: a page the reader CAN see, sitting under a parent they cannot, appears in the
// tree behind an unnamed placeholder. Before this module the payload carried such pages and no screen
// placed them (page-nodes.ts joins rows to branches by parentId, and an invisible parent is absent) —
// measured on dev: a private parent's granted children numbered zero in the tree, however many there
// were. From the granting side, the thing that was handed over never arrived.
//
// What a placeholder IS here: an opaque token, the id of its nearest VISIBLE ancestor (the one thing
// needed to place it — §4.5), an optional parent token (an invisible chain nests), and the visible
// pages under it. What it is NOT: §4.1's two blocked rows. It carries no field of the invisible page —
// not its id, title, position or child count — and it is never expandable through the branch route
// (§4.2: the chain is VOLUNTEERED in the same response; expanding a placeholder issues no request).

/**
 * §4.3's budget, shared by both paths and counted in nodes EXAMINED — rows walked plus Checks made,
 * not results returned. Path 2's cost follows the invisible subtree under the branch (for a space that
 * is mostly drafts, that is most of the space); results are unpageable by §4.2, so without this a
 * draft folder holding two hundred published children would put two hundred rows in one response with
 * no cursor. Exhaustion is a VISIBLE state on the response, never a short answer that looks complete.
 */
export const PLACEHOLDER_NODE_MAX = 200

/**
 * The direct-grant leaves that make a page viewable — `viewable`'s POSITIVE arms in model.fga (the
 * union feeding `view_base`), not its subtracted terms (`restricted`, `trashed`). `manage_direct`
 * matters most: a page's creator holds it, so reading only `view_direct` would hide people's own pages
 * from them. A model-derived test fails when the model grows a tenth arm this list does not read.
 */
export const TREE_VIEW_LEAVES = [
  'view_direct', 'comment_direct', 'edit_direct', 'manage_direct', 'delete_direct',
  'share_direct', 'settings_direct', 'publish_direct', 'moderate',
] as const

export interface PlaceholderNode {
  /** opaque, minted per response (§4.2: an id would be replayable at every other surface) */
  token: string
  /** the nearest VISIBLE ancestor's page id, or null when the chain reaches the branch root */
  under: string | null
  /** the enclosing placeholder's token, when the invisible chain is more than one node deep */
  parentToken: string | null
  /** the visible pages directly under this invisible node — Page-shaped, they open normally */
  pages: TreePage[]
}

/** The tree's page shape, structurally (pages.ts owns the real one; this module never reads content). */
export interface TreePage { id: string; [k: string]: unknown }

export interface PlaceholderResult {
  placeholders: PlaceholderNode[]
  /** the budget ran out: some pages could not be placed — a visible state, pointing at search */
  placeholdersExhausted: boolean
}

interface Ctx {
  db: TenantDb
  fga: OpenFgaClient
  spaceId: string
  subject: string
  context?: { current_time: string } | undefined
  toPage: (row: Record<string, unknown>) => TreePage
  budget: { left: number }
  /** internal: one node per invisible page across BOTH paths, so the two never draw it twice */
  byInvisibleId: Map<string, PlaceholderNode>
  out: PlaceholderNode[]
  exhausted: boolean
}

const PAGE_COLUMNS = (db: TenantDb) => db.sql`
  p.id, p.tenant_id, p.space_id, p.parent_id, p.title, p.position, p.created_at, p.updated_at,
  p.has_unpublished_changes, (p.published_at IS NOT NULL) AS published, p.task_done, p.task_total`

async function viewChecked(ctx: Ctx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  ctx.budget.left -= ids.length
  return new Set(await filterAuthorized(ctx.fga, ctx.subject, 'view', ids, ctx.context))
}

function nodeFor(ctx: Ctx, invisibleId: string, under: string | null, parentToken: string | null): PlaceholderNode {
  const had = ctx.byInvisibleId.get(invisibleId)
  if (had) return had
  const node: PlaceholderNode = { token: randomUUID(), under, parentToken, pages: [] }
  ctx.byInvisibleId.set(invisibleId, node)
  ctx.out.push(node)
  return node
}

/**
 * Path 2 — descend from the branch through the invisible (§4.3). The seeds are already in hand: the
 * complement of the branch read's allowed set. Walk DOWN through invisible nodes and stop at the first
 * visible descendants. This path asks "is anything visible under here", never "why is this hidden",
 * which is what lets one mechanism cover the draft, private and `restricted` causes alike — and pages
 * visible for reasons nobody enumerated.
 *
 * Built as DRAFTS, bottom-up, and materialised only when a subtree anchored something readable: §4
 * draws a placeholder ONLY as an anchor, so an all-invisible subtree leaves no trace — the
 * existence-hiding half of ruling ②. Materialising on the way down and retracting on failure
 * was the first draft of this function, and its retraction had corner cases; building upward cannot.
 */
interface Draft { invisibleId: string; pages: Record<string, unknown>[]; children: Draft[] }

async function descend(ctx: Ctx, invisibleId: string): Promise<Draft | null> {
  if (ctx.budget.left <= 0) { ctx.exhausted = true; return null }
  ctx.budget.left -= 1 // this node, examined
  const rows = await ctx.db.sql<Record<string, unknown>[]>`
    SELECT ${PAGE_COLUMNS(ctx.db)}
    FROM pages p JOIN spaces s ON s.id = p.space_id
    WHERE p.parent_id = ${invisibleId} AND p.space_id = ${ctx.spaceId} AND p.deleted_at IS NULL
      AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
    ORDER BY p.position, p.created_at
  `
  const visible = await viewChecked(ctx, rows.map((r) => r.id as string))
  const draft: Draft = { invisibleId, pages: [], children: [] }
  for (const r of rows) if (visible.has(r.id as string)) draft.pages.push(r)
  for (const r of rows) {
    if (visible.has(r.id as string)) continue
    if (ctx.budget.left <= 0) { ctx.exhausted = true; break }
    const child = await descend(ctx, r.id as string)
    if (child) draft.children.push(child)
  }
  return draft.pages.length || draft.children.length ? draft : null
}

/**
 * §4.1: a page delivered under a placeholder must not carry its raw parent id — that IS the invisible
 * page's id, and the first run of this module shipped it in every child row (caught by the wire pin).
 * Its placement is the placeholder; the field goes null.
 */
function placedPage(ctx: Ctx, row: Record<string, unknown>): TreePage {
  return { ...ctx.toPage(row), parentId: null }
}

function materialise(ctx: Ctx, draft: Draft, under: string | null, parentToken: string | null): void {
  const node = nodeFor(ctx, draft.invisibleId, under, parentToken)
  for (const r of draft.pages) {
    const pg = placedPage(ctx, r)
    if (!node.pages.some((p) => p.id === pg.id)) node.pages.push(pg)
  }
  for (const c of draft.children) materialise(ctx, c, null, node.token)
}

/**
 * Path 1 — the reader's own grants (§4.3), resolved relative to ONE branch. Cost follows what this
 * person (and their groups) was handed; zero for a reader with no grants. Runs FIRST, so the cheap and
 * precise results are never crowded out by path 2's subtree walk.
 */
async function grantsPath(ctx: Ctx, branchParentId: string | null, principals: string[]): Promise<void> {
  // Collect candidate page ids from direct viewing tuples. A tuple is a CANDIDATE, never a placement:
  // `viewable` is not `view` (restricted and trashed subtract later), so everything is Checked below.
  const candidates = new Set<string>()
  for (const principal of principals) {
    // ⚠️ Page-by-page, CHARGED PER PAGE — not read to completion. The first version read every tuple
    // first and charged one unit after, and for the member who created a space (manage_direct on all
    // of it) that is thousands of tuples in dozens of round trips before the budget was ever asked —
    // measured on #541's 197-page fixture, where it starved the paint this route exists to keep fast.
    // §4.3 said the cost "follows the roster"; the budget is only true of the roster walk if the walk
    // itself is metered.
    let cursor: string | undefined
    do {
      if (ctx.budget.left <= 0) { ctx.exhausted = true; return }
      ctx.budget.left -= 1
      const res = await ctx.fga.read({ user: principal, object: 'page:' },
        { pageSize: 50, ...(cursor ? { continuationToken: cursor } : {}) })
      for (const t of res.tuples ?? []) {
        const k = t.key
        if (k?.relation && k.object && (TREE_VIEW_LEAVES as readonly string[]).includes(k.relation)) {
          candidates.add(k.object.slice('page:'.length))
        }
      }
      cursor = res.continuation_token || undefined
    } while (cursor)
  }
  if (!candidates.size) return

  // The store is single and spans tenants and spaces: these ids are not proof of tenancy. The CTE
  // under the tenant tx — with space_id said out loud — decides which belong here (§4.3).
  for (const id of candidates) {
    if (ctx.budget.left <= 0) { ctx.exhausted = true; return }
    ctx.budget.left -= 1
    const chain = await ctx.db.sql<{ id: string; parent_id: string | null; depth: number }[]>`
      WITH RECURSIVE anc AS (
        SELECT p.id, p.parent_id, 0 AS depth FROM pages p
          JOIN spaces s ON s.id = p.space_id
         WHERE p.id = ${id} AND p.space_id = ${ctx.spaceId} AND p.deleted_at IS NULL
           AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
        UNION ALL
        SELECT p.id, p.parent_id, anc.depth + 1 FROM pages p
          JOIN anc ON p.id = anc.parent_id
         WHERE p.space_id = ${ctx.spaceId} AND p.deleted_at IS NULL AND anc.depth < 12
      )
      SELECT id, parent_id, depth FROM anc ORDER BY depth DESC
    `
    if (!chain.length) continue // another space, trashed, or the space home — not this tree's business
    // chain is root-first…candidate-last. Check the whole line in one batch.
    const ids = chain.map((r) => r.id)
    const visible = await viewChecked(ctx, ids)
    const candidateId = ids[ids.length - 1]!
    if (!visible.has(candidateId)) continue // a candidate is not a placement
    // Find the nearest visible ancestor ABOVE the candidate and the invisible run under it.
    let nearestVisible: string | null = null
    let runStart = 0
    for (let i = ids.length - 2; i >= 0; i--) {
      if (visible.has(ids[i]!)) { nearestVisible = ids[i]!; runStart = i + 1; break }
    }
    const invisibleRun = ids.slice(runStart, ids.length - 1)
    if (!invisibleRun.length) continue // normally placed; the branch read already carries it
    // Belongs to THIS response only if the chain hangs off the branch being resolved (§4.2: the chain
    // rides the branch response that contains it).
    if (nearestVisible !== branchParentId) continue
    let parentToken: string | null = null
    let under: string | null = nearestVisible
    let node: PlaceholderNode | null = null
    for (const inv of invisibleRun) {
      node = nodeFor(ctx, inv, parentToken === null ? under : null, parentToken)
      parentToken = node.token
      under = null
    }
    const row = await ctx.db.sql<Record<string, unknown>[]>`
      SELECT ${PAGE_COLUMNS(ctx.db)} FROM pages p WHERE p.id = ${candidateId}`
    if (row[0] && node && !node.pages.some((pg) => pg.id === candidateId)) node.pages.push(placedPage(ctx, row[0]))
  }
}

/**
 * Resolve §4's placeholders for one branch.
 *
 * `invisibleChildIds` are path 2's seeds — the branch read already Checked its children, so the
 * invisible ones are in hand and this module never re-asks. `groups` are the session's group NAMES;
 * the principal ids are derived here through the same function the sync uses (`groupGrantee`) —
 * reading `group:<name>#member` returns nothing, silently.
 *
 * §4.4: resolved only when the ambient authz scope carries NO restriction. A confined API key is a
 * `user:` principal whose confinement lives in the scope, and neither the tuple Read nor the SQL walk
 * goes through the primitives that apply it — so a restricted scope yields no placeholders at all, the
 * direction that cannot leak. share_link subjects never resolve (§4.4: settled by principal type).
 */
export async function resolveTreePlaceholders(
  db: TenantDb,
  fga: OpenFgaClient,
  args: {
    spaceId: string
    tenantId: string
    branchParentId: string | null
    subject: string
    groups: string[]
    invisibleChildIds: string[]
    context?: { current_time: string } | undefined
    toPage: (row: Record<string, unknown>) => TreePage
    budget?: { left: number }
  },
): Promise<PlaceholderResult> {
  if (!args.subject.startsWith('user:')) return { placeholders: [], placeholdersExhausted: false }
  // `currentAuthzScope`, not `authzScopeForCheck`: outside any scope (unit tests, the CLI) there is no
  // confinement to honour and resolving is correct; inside one, a restriction means STOP. The serving
  // process requires scopes at the entrypoint, so "null scope = unrestricted" cannot arise there.
  const scope = currentAuthzScope()
  if (scope?.restriction) return { placeholders: [], placeholdersExhausted: false }

  const ctx: Ctx = {
    db, fga, spaceId: args.spaceId, subject: args.subject, context: args.context, toPage: args.toPage,
    budget: args.budget ?? { left: PLACEHOLDER_NODE_MAX },
    byInvisibleId: new Map(), out: [], exhausted: false,
  }
  const principals = [args.subject, ...args.groups.map((g) => groupGrantee(args.tenantId, g))]
  await grantsPath(ctx, args.branchParentId, principals)
  for (const seed of args.invisibleChildIds) {
    if (ctx.budget.left <= 0) { ctx.exhausted = true; break }
    const draft = await descend(ctx, seed)
    if (draft) materialise(ctx, draft, args.branchParentId, null)
  }
  return { placeholders: ctx.out, placeholdersExhausted: ctx.exhausted }
}

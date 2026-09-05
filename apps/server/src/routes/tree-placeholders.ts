import { randomUUID } from 'node:crypto'
import type { OpenFgaClient } from '@openfga/sdk'
import { filterAuthorized, currentAuthzScope } from '@wikistead/authz'
import type { TenantDb } from '../db/index.js'
import { groupGrantee } from '../auth/group-sync.js'
import { encodePlaceholderCursor, decodePlaceholderCursor, type PlaceholderCursorScope } from './tree-placeholders-cursor.js'

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
//
// #1141 / ADR-220 §4.2 rev (2026-09-06): the budget below is no longer a giving-up point. A call that
// spends it before the walk finishes returns a `placeholderCursor` alongside whatever it DID find, and
// a follow-up call carrying just that cursor picks the SAME walk up where it left off — the same shape
// `nextCursor` already gives a branch's own direct children (§1-3). See `descendAll`/`grantsPath`'s own
// comments for how each path resumes without re-examining, or re-reporting, anything a prior call
// already settled.

/**
 * §4.3's budget, shared by both paths and counted in nodes EXAMINED — rows walked plus Checks made,
 * not results returned. Path 2's cost follows the invisible subtree under the branch (for a space that
 * is mostly drafts, that is most of the space); results are unpageable by §4.2, so without this a
 * draft folder holding two hundred published children would put two hundred rows in one response with
 * no cursor. Spending the whole budget is a visible, RESUMABLE state (§1141) — never a short answer
 * that looks complete, and never a dead end either.
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
  /** #1141: present when this call's budget ran out before the walk finished — an opaque cursor a
   * follow-up call presents (and nothing else) to continue. Absent (undefined) once nothing remains
   * unexplored. Superseded `placeholdersExhausted` (§4.2 rev, #1141): that flag told the reader
   * something failed and gave them no way to see the rest — this field IS the way to see the rest. */
  placeholderCursor?: string
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
 * §4.1: a page delivered under a placeholder must not carry its raw parent id — that IS the invisible
 * page's id, and the first run of this module shipped it in every child row (caught by the wire pin).
 * Its placement is the placeholder; the field goes null.
 */
function placedPage(ctx: Ctx, row: Record<string, unknown>): TreePage {
  return { ...ctx.toPage(row), parentId: null }
}

/** One node still queued for path 2's exploration. `path` is the chain of REAL invisible ancestor ids
 * from (but excluding) the branch root down to (but excluding) this entry's own `invisibleId` — kept
 * so a RESUMED call, starting from a brand-new `Ctx` (a fresh `byInvisibleId` map, since anchor tokens
 * are per-response, §4.1), can still walk `ensureChain` to reach — or lazily create — the right parent
 * anchor before attaching anything this entry turns out to find. */
interface Frontier { invisibleId: string; path: string[] }

/**
 * Path 2 — descend from the branch through the invisible (§4.3). The seeds are the branch read's own
 * complement (children the reader cannot view). Walk DOWN through invisible nodes and stop at the
 * first visible descendants. This path asks "is anything visible under here", never "why is this
 * hidden", which is what lets one mechanism cover the draft, private and `restricted` causes alike —
 * and pages visible for reasons nobody enumerated.
 *
 * #1141 rewrite: an EXPLICIT stack (was: recursion building a Draft tree, materialised afterward),
 * because a paused walk's remaining work has to be a plain, serialisable value (the stack itself) —
 * recursion's call frames are not. The anchor-creation rule this preserves byte-for-byte: an invisible
 * node's own PlaceholderNode is created ONLY the instant something worth anchoring is found under it —
 * one of its own direct visible children, or (via `ensureChain` walking a deeper hit's stored `path`)
 * a visible descendant several levels down. A node explored on THIS call that turns out to have no
 * visible descendant AT ALL still gets no anchor and leaves no trace, even if a SIBLING invisible
 * branch two calls later turns out to hide something (§4's ruling ② — a subtree that is invisible all
 * the way down does not exist, tree-wise, no matter how many calls it takes to find that out).
 *
 * Explored nodes are never re-queued: each is popped from the stack, its own direct children read and
 * Check'd exactly once, and any invisible children found get pushed as NEW frontier entries. A real
 * page is therefore examined, and — if visible — reported, AT MOST ONCE across however many calls the
 * whole walk takes; nothing here can duplicate a page a prior call already returned. An anchor's own
 * TOKEN, by contrast, is free to be re-minted for the same real invisible id across calls (a call that
 * eventually finds a hit under a long-invisible chain re-creates that chain's anchors fresh) — harmless
 * per §4.1 (an anchor carries no identifying field, so two of them are indistinguishable from one).
 */
function descendAll(ctx: Ctx, branchParentId: string | null, stack: Frontier[]): Promise<Frontier[]> {
  const ensureChain = (path: string[], invisibleId: string): PlaceholderNode => {
    let under: string | null = branchParentId
    let parentToken: string | null = null
    for (const ancestor of path) {
      const node = nodeFor(ctx, ancestor, parentToken === null ? under : null, parentToken)
      parentToken = node.token
      under = null
    }
    return nodeFor(ctx, invisibleId, parentToken === null ? under : null, parentToken)
  }

  return (async () => {
    while (stack.length) {
      if (ctx.budget.left <= 0) return stack // leftover frontier — the caller mints a cursor from it
      const item = stack.pop()!
      ctx.budget.left -= 1 // this node, examined
      const rows = await ctx.db.sql<Record<string, unknown>[]>`
        SELECT ${PAGE_COLUMNS(ctx.db)}
        FROM pages p JOIN spaces s ON s.id = p.space_id
        WHERE p.parent_id = ${item.invisibleId} AND p.space_id = ${ctx.spaceId} AND p.deleted_at IS NULL
          AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
        ORDER BY p.position, p.created_at
      `
      const visible = await viewChecked(ctx, rows.map((r) => r.id as string))
      const visibleRows = rows.filter((r) => visible.has(r.id as string))
      const invisibleRows = rows.filter((r) => !visible.has(r.id as string))
      if (visibleRows.length) {
        const node = ensureChain(item.path, item.invisibleId)
        for (const r of visibleRows) {
          const pg = placedPage(ctx, r)
          if (!node.pages.some((p) => p.id === pg.id)) node.pages.push(pg)
        }
      }
      // Reverse push: a stack pops last-in-first-out, so pushing in reverse row order means the FIRST
      // (by position) invisible child is the next one popped — left-to-right exploration order, same
      // as the original recursive version's two sequential row-order loops.
      for (let i = invisibleRows.length - 1; i >= 0; i--) {
        const r = invisibleRows[i]!
        stack.push({ invisibleId: r.id as string, path: [...item.path, item.invisibleId] })
      }
    }
    return [] // fully resolved — nothing left to explore
  })()
}

/**
 * Path 1 — the reader's own grants (§4.3), resolved relative to ONE branch. Cost follows what this
 * person (and their groups) was handed; zero for a reader with no grants. Runs FIRST, so the cheap and
 * precise results are never crowded out by path 2's subtree walk — a previously-ruled ordering
 * (ADR-220's own Acceptance section) that #1141 does not touch.
 *
 * #1141 rewrite: two resumable phases, `roster` (reading each principal's own direct-grant tuples,
 * paginated by FGA's own continuation token) and `candidates` (resolving each collected candidate id's
 * ancestor chain). Phase `candidates` cannot duplicate a report: each candidate is resolved (found to
 * be a placement, or ruled out) exactly once, in list order, and a resumed call is handed the exact
 * REMAINDER of that list — nothing already resolved is looked at again. Phase `roster` cannot
 * duplicate a CANDIDATE (a Set): re-reading a principal's tuples from a resumed cursor only ever ADDS
 * ids, and a candidate already resolved by a phase-`candidates` pass from an EARLIER call never reaches
 * this phase again in the first place (this only runs at all when `candidates` has not started yet).
 */
export type GrantsPathState =
  | { phase: 'roster'; principalIndex: number; cursor?: string; candidates: string[] }
  | { phase: 'candidates'; remaining: string[] }

async function resolveCandidates(ctx: Ctx, branchParentId: string | null, list: string[]): Promise<GrantsPathState | undefined> {
  for (let i = 0; i < list.length; i++) {
    if (ctx.budget.left <= 0) return { phase: 'candidates', remaining: list.slice(i) }
    ctx.budget.left -= 1
    const id = list[i]!
    // The store is single and spans tenants and spaces: these ids are not proof of tenancy. The CTE
    // under the tenant tx — with space_id said out loud — decides which belong here (§4.3).
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
    const ids = chain.map((r) => r.id)
    const visible = await viewChecked(ctx, ids)
    const candidateId = ids[ids.length - 1]!
    if (!visible.has(candidateId)) continue // a candidate is not a placement
    let nearestVisible: string | null = null
    let runStart = 0
    for (let j = ids.length - 2; j >= 0; j--) {
      if (visible.has(ids[j]!)) { nearestVisible = ids[j]!; runStart = j + 1; break }
    }
    const invisibleRun = ids.slice(runStart, ids.length - 1)
    if (!invisibleRun.length) continue // normally placed; the branch read already carries it
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
  return undefined
}

async function grantsPath(
  ctx: Ctx,
  branchParentId: string | null,
  principals: string[],
  resume: GrantsPathState | undefined,
): Promise<GrantsPathState | undefined> {
  if (resume?.phase === 'candidates') return resolveCandidates(ctx, branchParentId, resume.remaining)

  const candidates = new Set<string>(resume?.candidates ?? [])
  const startIndex = resume?.principalIndex ?? 0
  let carriedCursor = resume?.cursor
  for (let pi = startIndex; pi < principals.length; pi++) {
    const principal = principals[pi]!
    // ⚠️ Page-by-page, CHARGED PER PAGE — not read to completion. The first version read every tuple
    // first and charged one unit after, and for the member who created a space (manage_direct on all
    // of it) that is thousands of tuples in dozens of round trips before the budget was ever asked —
    // measured on #541's 197-page fixture, where it starved the paint this route exists to keep fast.
    // §4.3 said the cost "follows the roster"; the budget is only true of the roster walk if the walk
    // itself is metered.
    let cursor: string | undefined = pi === startIndex ? carriedCursor : undefined
    carriedCursor = undefined
    do {
      if (ctx.budget.left <= 0) return { phase: 'roster', principalIndex: pi, cursor, candidates: [...candidates] }
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
  if (!candidates.size) return undefined
  return resolveCandidates(ctx, branchParentId, [...candidates])
}

/** #1141: the shape a follow-up request presents, and nothing else — no branch/space parameter rides
 * along with it (that comes from the ordinary `parent` query param the branch route already reads;
 * `decodePlaceholderCursor` refuses a cursor whose scope does not match that same branch anyway, so
 * carrying a redundant one would only ever disagree with itself, never add a real client-chosen knob). */
interface PlaceholderWalkState {
  grantsPath?: GrantsPathState // present only while path 1 has not yet finished
  frontier: Frontier[] // path 2's remaining work; empty once path 2 has nothing left either
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
 * This refusal is re-checked on EVERY call, resumed ones included — a cursor cannot buy its way past a
 * scope that tightened between calls.
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
    /** #1141: the previous call's `placeholderCursor`, verbatim, or undefined to start fresh. */
    cursor?: string
  },
): Promise<PlaceholderResult> {
  if (!args.subject.startsWith('user:')) return { placeholders: [] }
  // `currentAuthzScope`, not `authzScopeForCheck`: outside any scope (unit tests, the CLI) there is no
  // confinement to honour and resolving is correct; inside one, a restriction means STOP. The serving
  // process requires scopes at the entrypoint, so "null scope = unrestricted" cannot arise there.
  const scope = currentAuthzScope()
  if (scope?.restriction) return { placeholders: [] }

  const cursorScope: PlaceholderCursorScope = {
    tenantId: args.tenantId, subject: args.subject, spaceId: args.spaceId, branchParentId: args.branchParentId,
  }
  const resumed = decodePlaceholderCursor<PlaceholderWalkState>(args.cursor, cursorScope)

  const ctx: Ctx = {
    db, fga, spaceId: args.spaceId, subject: args.subject, context: args.context, toPage: args.toPage,
    budget: args.budget ?? { left: PLACEHOLDER_NODE_MAX },
    byInvisibleId: new Map(), out: [],
  }
  const principals = [args.subject, ...args.groups.map((g) => groupGrantee(args.tenantId, g))]

  let grantsState: GrantsPathState | undefined
  let frontier: Frontier[]
  if (resumed) {
    frontier = resumed.frontier
    if (resumed.grantsPath) {
      grantsState = await grantsPath(ctx, args.branchParentId, principals, resumed.grantsPath)
      if (!grantsState) frontier = args.invisibleChildIds.map((id) => ({ invisibleId: id, path: [] }))
    }
  } else {
    grantsState = await grantsPath(ctx, args.branchParentId, principals, undefined)
    frontier = args.invisibleChildIds.map((id) => ({ invisibleId: id, path: [] }))
  }

  if (!grantsState) frontier = await descendAll(ctx, args.branchParentId, frontier)

  if (!grantsState && frontier.length === 0) return { placeholders: ctx.out }
  return {
    placeholders: ctx.out,
    placeholderCursor: encodePlaceholderCursor<PlaceholderWalkState>(
      { ...(grantsState ? { grantsPath: grantsState } : {}), frontier }, cursorScope,
    ),
  }
}

/**
 * Path 2 ONLY, for a guest's whole-space closure walk (#903 / ADR-220 §14). `resolveTreePlaceholders`
 * refuses any subject that is not `user:`-prefixed (§4.4) — deliberately, since path 1 (`grantsPath`)
 * reads a principal's OWN direct-grant tuples, which a `share_link:` subject never has (its view arrives
 * through the space cascade, not a page-level grant —). Path 2 (`descendAll`) only asks
 * `filterAuthorized(subject, 'view', …)`, so it is subject-shape-independent; this calls it directly,
 * skipping both the gate and path 1.
 *
 * Returns §4's `PlaceholderNode` grouping — the same shape the member tree already gets (owner ruling
 * 2026-09-05, #903 the hierarchy is not flattened for a guest). The earlier form returned the
 * descended pages FLAT with `parentId` nulled and let `GuestSidebar` re-root them among the space's
 * real roots; that put a page from inside a hidden folder on the top level, sorted by an ordinal
 * nobody could see the meaning of, and it made the guest surface the only one in the product that
 * answers this situation by discarding the tree.
 *
 * The disclosure the anchor makes — "there is a node here you cannot view" — was ruled acceptable for
 * a share-link principal on the same grounds §4 ruling ② accepted it for members: the node carries no
 * field of the invisible page (§4.1 — not its id, title, position or child count), one unnamed label
 * covers every cause, and it is not expandable through any route (§4.2: the chain is volunteered in
 * this same response, and expanding it issues no request). What uniform-404 protects is asking about a
 * NAMED id; a volunteered anchor cannot be aimed at anything.
 */
export async function resolveGuestPlaceholders(
  db: TenantDb,
  fga: OpenFgaClient,
  args: {
    spaceId: string
    /** the visible parent whose branch read produced these seeds — the anchors' `under` (§4.5) */
    branchParentId: string | null
    subject: string
    invisibleChildIds: string[]
    context?: { current_time: string } | undefined
    toPage: (row: Record<string, unknown>) => TreePage
    budget: { left: number }
    /** #1141: opaque, from a prior call's `placeholderCursor` — see `resolveTreePlaceholders`. */
    cursor?: string
    /** required to bind/verify the cursor — the guest closure walk's own tenant and (real) space id. */
    tenantId: string
  },
): Promise<{ placeholders: PlaceholderNode[]; placeholderCursor?: string }> {
  // Same defence as §4.4's scope check, kept for a confined caller even though guest requests never
  // carry a restriction today (only an API-key-scoped request does — `setAuthzRestriction` in app.ts).
  const scope = currentAuthzScope()
  if (scope?.restriction) return { placeholders: [] }
  const cursorScope: PlaceholderCursorScope = {
    tenantId: args.tenantId, subject: args.subject, spaceId: args.spaceId, branchParentId: args.branchParentId,
  }
  const resumed = decodePlaceholderCursor<{ frontier: Frontier[] }>(args.cursor, cursorScope)
  const ctx: Ctx = {
    db, fga, spaceId: args.spaceId, subject: args.subject, context: args.context, toPage: args.toPage,
    budget: args.budget, byInvisibleId: new Map(), out: [],
  }
  const seedFrontier = resumed?.frontier ?? args.invisibleChildIds.map((id) => ({ invisibleId: id, path: [] }))
  const frontier = await descendAll(ctx, args.branchParentId, seedFrontier)
  if (frontier.length === 0) return { placeholders: ctx.out }
  return { placeholders: ctx.out, placeholderCursor: encodePlaceholderCursor({ frontier }, cursorScope) }
}

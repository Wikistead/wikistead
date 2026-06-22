import * as Y from 'yjs'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, checkMemberAccess, filterAuthorized, writeTuples, deleteTuples, deleteObjectTuples } from '@wikistead/authz'
import { emit } from '@wikistead/events'
import { enqueueOutbox, processOutboxAsync } from '../search/index.js'
import type { SearchDriver } from '../search/index.js'
import type { TenantDb } from '../db/index.js'

interface PageRow { id: string; tenant_id: string; space_id: string; parent_id: string | null; title: string; position: number; created_at: Date; updated_at: Date; has_unpublished_changes?: boolean; published?: boolean }
export interface Page { id: string; tenantId: string; spaceId: string; parentId: string | null; title: string; position: number; createdAt: Date; updatedAt: Date; capability?: 'view' | 'edit'; hasUnpublishedChanges?: boolean; published?: boolean }
function toPage(r: PageRow): Page {
  // hasUnpublishedChanges + published are only present when the SELECT included the
  // columns (listPages); together they drive the sidebar's 3-state badge
  // (Draft / Published / Unpublished changes). `published` is a cheap check
  // (published_at IS NOT NULL) — the heavy published_md is not read for the tree.
  return { id: r.id, tenantId: r.tenant_id, spaceId: r.space_id, parentId: r.parent_id, title: r.title, position: r.position, createdAt: r.created_at, updatedAt: r.updated_at, hasUnpublishedChanges: r.has_unpublished_changes ?? false, published: r.published ?? false }
}

// Fractional sibling ordering: a new value between two neighbours, no renumber.
// front = min-1, end = max+1, between = midpoint, empty = 0.
//
// v1 uses a float midpoint (chosen over a LexoRank-style string rank to avoid the
// string min-boundary edge; both satisfy the no-renumber / single-row-UPDATE
// concurrency property). KNOWN LIMITATION: ~53 consecutive inserts into the SAME
// gap make two positions compare equal (float precision exhaustion) and the order
// becomes ambiguous.
// TODO(phase: tree-rebalance): detect a collapsed/duplicate gap and re-spread the
//   affected siblings' positions (or switch to a LexoRank string key). Until then
//   listPages tie-breaks equal positions by created_at so order stays stable.
function positionBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 0
  if (before == null) return (after as number) - 1
  if (after == null) return before + 1
  return (before + after) / 2
}

// Decode the markdown body from a persisted Y.Doc binary (the canonical 'content'
// Y.Text). null/never-edited → ''. Used by publish (draft → published snapshot) and
// the published-read endpoint's draft-vs-published comparison.
function decodeYdocContent(buf: Buffer | null): string {
  if (!buf) return ''
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(buf))
  return doc.getText('content').toString()
}

// ── Service functions ─────────────────────────────────────────────────────

// Create a page. Outbox entry is written in the same DB transaction as the
// INSERT + FGA write. Meili indexing fires asynchronously after tx commits
// (non-blocking: API success is independent of Meili availability).
export async function createPage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { tenantId: string; spaceId: string; userId: string; title?: string; parentId?: string | null },
): Promise<Page> {
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'space', id: args.spaceId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const parentId = args.parentId ?? null
  if (parentId) {
    // Nesting is structural only and stays within one space; the parent must be
    // a page in the SAME space (the composite FK already blocks cross-tenant).
    const [p] = await db.sql<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${parentId}`
    if (!p || p.space_id !== args.spaceId) throw Object.assign(new Error('parent not in space'), { statusCode: 400 })
  }
  // Append to the end of its sibling list (max position + 1).
  const [{ pos }] = await db.sql<[{ pos: number | null }]>`
    SELECT MAX(position) AS pos FROM pages
    WHERE space_id = ${args.spaceId} AND parent_id IS NOT DISTINCT FROM ${parentId}
  `
  const position = positionBetween(pos, null)

  let outboxId!: string
  const row = await db.tx(async (tx) => {
    const [r] = await tx<PageRow[]>`
      INSERT INTO pages (tenant_id, space_id, parent_id, title, position)
      VALUES (${args.tenantId}, ${args.spaceId}, ${parentId}, ${args.title ?? ''}, ${position})
      RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    `
    await writeTuples(fga, [
      { user: `space:${args.spaceId}`, relation: 'space', object: `page:${r.id}` },
    ])
    outboxId = await enqueueOutbox(tx, { tenantId: args.tenantId, pageId: r.id, operation: 'upsert' })
    return r
  })
  const page = toPage(row as PageRow)
  processOutboxAsync(driver, outboxId, { tenantId: args.tenantId, pageId: page.id, operation: 'upsert' })
  emit({ type: 'page.created', tenantId: args.tenantId, pageId: page.id, spaceId: args.spaceId, actorId: args.userId })
  return page
}

// List the pages in a space the user is allowed to VIEW. RLS gives only tenant
// isolation; per-page view authorization is enforced here so the page tree never
// lists (or leaks the title of) a page the user cannot open — the same
// "confirm via OpenFGA before display" rule the search two-stage guard follows
// (the project design notes). A page the user lacks `view` on is excluded.
export async function listPages(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { spaceId: string; userId: string },
): Promise<Page[]> {
  const rows = await db.sql<PageRow[]>`
    SELECT id, tenant_id, space_id, parent_id, title, position, created_at, updated_at,
           has_unpublished_changes, (published_at IS NOT NULL) AS published
    FROM pages WHERE space_id = ${args.spaceId} ORDER BY position, created_at
  `
  const allowed = await filterAuthorized(fga, `user:${args.userId}`, 'view', rows.map((r) => r.id))
  return rows.filter((r) => allowed.has(r.id)).map(toPage)
}

export async function getPage(db: TenantDb, fga: OpenFgaClient, args: { pageId: string; userId: string }): Promise<Page> {
  // Resolve view AND edit in one batch: the web uses `capability` to decide whether
  // to offer the Edit control. This is convenience only — the collab server is the
  // fortress (it re-derives readOnly from FGA per document, so a forged edit button
  // still cannot write). null = no view access at all → 403.
  const access = await checkMemberAccess(fga, args.userId, { type: 'page', id: args.pageId })
  if (!access) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const [row] = await db.sql<PageRow[]>`
    SELECT id, tenant_id, space_id, parent_id, title, position, created_at, updated_at, has_unpublished_changes
    FROM pages WHERE id = ${args.pageId}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  return { ...toPage(row), capability: access.readOnly ? 'view' : 'edit' }
}

// Update title. Outbox entry written in the same tx as the UPDATE.
export async function updatePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; userId: string; title: string },
): Promise<Page> {
  const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'page', id: args.pageId })
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  let outboxId!: string
  const row = await db.tx(async (tx) => {
    const [r] = await tx<PageRow[]>`
      UPDATE pages SET title = ${args.title}, updated_at = now()
      WHERE id = ${args.pageId}
      RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    `
    if (!r) throw Object.assign(new Error('not found'), { statusCode: 404 })
    outboxId = await enqueueOutbox(tx, { tenantId: r.tenant_id, pageId: args.pageId, operation: 'upsert' })
    return r
  })
  const page = toPage(row as PageRow)
  processOutboxAsync(driver, outboxId, { tenantId: page.tenantId, pageId: page.id, operation: 'upsert' })
  emit({ type: 'page.updated', tenantId: page.tenantId, pageId: page.id, actorId: args.userId })
  return page
}

// Publish: promote the current draft (pages.ydoc) to the published version. The
// published snapshot is what viewers / search / export / public render read, so a
// draft's in-progress content never leaks until published. edit-gated (a guest with
// an edit share-link qualifies — guest-token auth on this route is wired in 2f-3).
//
// A revision records the published snapshot (this is the history entry — the old
// 5-min auto-snapshot was removed; history is now the publish history). ADR-003
// order: the DB tx commits (revision + published_* + outbox) before the async
// reindex + emit, so a tx failure leaves NO half-published state.
export async function publishPage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  // subject = FGA principal for the edit check ("user:<sub>" | "share_link:<id>");
  // createdBy attributes the revision/event ("user:<sub>" | "guest:<id>"); context
  // (guests) evaluates the share_link's non_expired condition.
  args: { pageId: string; subject: string; createdBy: string; context?: { current_time: string } },
): Promise<{ publishedAt: Date | null; revisionId: string | null; noop: boolean }> {
  const canEdit = await check(fga, args.subject, 'edit', { type: 'page', id: args.pageId }, args.context)
  if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const [draft] = await db.sql<[{ tenant_id: string; ydoc: Buffer | null; title: string; published_md: string | null; published_at: Date | null; published_revision_id: string | null }]>`
    SELECT tenant_id, ydoc, title, published_md, published_at, published_revision_id FROM pages WHERE id = ${args.pageId}
  `
  if (!draft) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const md = decodeYdocContent(draft.ydoc)

  // No-op guard (server is the accurate gate): if the draft text equals what is
  // already published, do NOT create a revision — that would be meaningless history.
  // The UI's enable/disable uses the cheap over-approximated flag; this is the exact
  // check. Reconcile the cheap flag to false so a spurious "unpublished" badge clears.
  if (md === draft.published_md) {
    await db.sql`UPDATE pages SET has_unpublished_changes = false WHERE id = ${args.pageId}`
    return { publishedAt: draft.published_at, revisionId: draft.published_revision_id, noop: true }
  }

  // revisions.ydoc is NOT NULL — a never-edited page publishes an empty Y.Doc.
  const ydocBuf = draft.ydoc ?? Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()))

  let outboxId!: string
  let revisionId!: string
  let publishedAt!: Date
  await db.tx(async (tx) => {
    const [rev] = await tx<[{ id: string }]>`
      INSERT INTO revisions (tenant_id, page_id, ydoc, title, created_by)
      VALUES (${draft.tenant_id}, ${args.pageId}, ${ydocBuf}, ${draft.title}, ${args.createdBy})
      RETURNING id
    `
    revisionId = rev.id
    const [p] = await tx<[{ published_at: Date }]>`
      UPDATE pages SET published_md = ${md}, published_revision_id = ${rev.id}, published_at = now(),
        has_unpublished_changes = false
      WHERE id = ${args.pageId}
      RETURNING published_at
    `
    publishedAt = p.published_at
    outboxId = await enqueueOutbox(tx, { tenantId: draft.tenant_id, pageId: args.pageId, operation: 'upsert' })
  })
  processOutboxAsync(driver, outboxId, { tenantId: draft.tenant_id, pageId: args.pageId, operation: 'upsert' })
  emit({ type: 'page.published', tenantId: draft.tenant_id, pageId: args.pageId, revisionId, actorId: args.createdBy })
  return { publishedAt, revisionId, noop: false }
}

// Read the published content (view-gated). hasUnpublishedChanges = the live shared
// draft differs from the published snapshot — a PAGE-level state (the draft is one
// shared collaborative doc, not per-user), shown to all editors.
export async function getPublished(
  db: TenantDb,
  fga: OpenFgaClient,
  // subject is the FGA principal ("user:<sub>" | "share_link:<id>"); guests pass a
  // context so the share_link's non_expired condition is evaluated (expired = denied).
  args: { pageId: string; subject: string; context?: { current_time: string } },
): Promise<{ publishedMd: string | null; publishedAt: Date | null; hasUnpublishedChanges: boolean }> {
  const canView = await check(fga, args.subject, 'view', { type: 'page', id: args.pageId }, args.context)
  if (!canView) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  const [row] = await db.sql<[{ published_md: string | null; published_at: Date | null; ydoc: Buffer | null }]>`
    SELECT published_md, published_at, ydoc FROM pages WHERE id = ${args.pageId}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
  const hasUnpublishedChanges = decodeYdocContent(row.ydoc) !== (row.published_md ?? '')
  return { publishedMd: row.published_md, publishedAt: row.published_at, hasUnpublishedChanges }
}

// All descendant page ids of root (RLS-scoped to the tenant), via the parent_id tree.
async function descendantIds(db: TenantDb, rootId: string): Promise<string[]> {
  const rows = await db.sql<{ id: string }[]>`
    WITH RECURSIVE d AS (
      SELECT id FROM pages WHERE parent_id = ${rootId}
      UNION ALL
      SELECT p.id FROM pages p JOIN d ON p.parent_id = d.id
    )
    SELECT id FROM d
  `
  return rows.map((r) => r.id)
}

// Swap each page's direct `space:<id>#space@page:<id>` grant from oldSpace to
// newSpace, in the ORDER delete-OLD → add-NEW (ADR-003). Authorization for a
// page derives solely from its space (page#parent is unwired), so a cross-space
// move must re-point every page in the moved subtree.
//
// Ordering matters for the failure mode: by deleting OLD first, the only
// reachable intermediate is "the page is grantless = invisible from ANY space"
// — never "granted by BOTH spaces" (which would leak the page to the source
// space's members after it has logically left). If the add-NEW write throws, the
// caller's surrounding tx rolls the DB back to oldSpace, leaving the page
// fail-closed (invisible) and the move retryable.
//
// The OLD delete is idempotent and surgical: we read each page's tuples and
// delete only the oldSpace `space` grant that actually exists, so a retry after a
// partial failure is safe and share_link grants on the page are left untouched.
async function swapSpaceTuples(
  fga: OpenFgaClient,
  oldSpace: string,
  newSpace: string,
  pageIds: string[],
): Promise<void> {
  const deletes: { user: string; relation: string; object: string }[] = []
  const writes: { user: string; relation: string; object: string }[] = []
  for (const id of pageIds) {
    const { tuples } = await fga.read({ object: `page:${id}` })
    const keys = (tuples ?? []).map((t) => t.key).filter((k): k is NonNullable<typeof k> => !!k)
    if (keys.some((k) => k.relation === 'space' && k.user === `space:${oldSpace}`)) {
      deletes.push({ user: `space:${oldSpace}`, relation: 'space', object: `page:${id}` })
    }
    if (!keys.some((k) => k.relation === 'space' && k.user === `space:${newSpace}`)) {
      writes.push({ user: `space:${newSpace}`, relation: 'space', object: `page:${id}` })
    }
  }
  if (deletes.length) await deleteTuples(fga, deletes) // (1) OLD removed → invisible from any space
  if (writes.length) await writeTuples(fga, writes) // (2) NEW added; if this throws, see caller rollback
}

// Move/reorder a page: change parent_id, position, and optionally its space.
//
// Intra-space (no space change): permissions derive from the space and don't
// change, so this needs `edit` on the page. It is a single-row UPDATE of a
// fractional position between the new neighbours (no sibling renumber →
// concurrent moves of different pages don't conflict).
//
// Cross-space (3b ②): the whole subtree follows the page into the destination
// space, so it needs `manage` on the page (a structural ownership change) AND
// `edit` on the destination space. ADR-003 (DB-first): the DB writes and the FGA
// tuple swap run inside one tx with the FGA swap LAST, so a swap failure throws
// and rolls the DB back (no ghost authorization), and only the commit itself can
// fall after a successful swap.
export async function movePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; userId: string; parentId: string | null; afterId: string | null; spaceId?: string | null },
): Promise<Page> {
  const [page] = await db.sql<PageRow[]>`
    SELECT id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    FROM pages WHERE id = ${args.pageId}
  `
  if (!page) throw Object.assign(new Error('not found'), { statusCode: 404 })

  const newParent = args.parentId ?? null
  let targetSpace = args.spaceId ?? page.space_id
  if (newParent) {
    const [p] = await db.sql<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${newParent}`
    if (!p) throw Object.assign(new Error('parent not found'), { statusCode: 400 })
    if (args.spaceId != null && p.space_id !== args.spaceId) {
      throw Object.assign(new Error('parent not in target space'), { statusCode: 400 })
    }
    targetSpace = p.space_id // the parent's space is authoritative for the destination
  }
  const crossSpace = targetSpace !== page.space_id

  // Authorization: cross-space is a structural ownership move.
  if (crossSpace) {
    const [canManage, canEditDest] = await Promise.all([
      check(fga, `user:${args.userId}`, 'manage', { type: 'page', id: args.pageId }),
      check(fga, `user:${args.userId}`, 'edit', { type: 'space', id: targetSpace }),
    ])
    if (!canManage || !canEditDest) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  } else {
    const canEdit = await check(fga, `user:${args.userId}`, 'edit', { type: 'page', id: args.pageId })
    if (!canEdit) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  }

  // No cycles: a page cannot be nested under itself or its own descendant.
  if (newParent) {
    if (newParent === args.pageId) throw Object.assign(new Error('cannot nest under itself'), { statusCode: 400 })
    if ((await descendantIds(db, args.pageId)).includes(newParent)) {
      throw Object.assign(new Error('cannot nest under own descendant'), { statusCode: 400 })
    }
  }

  // Position between afterId and the next sibling in the DESTINATION sibling list.
  const sibs = await db.sql<{ id: string; position: number }[]>`
    SELECT id, position FROM pages
    WHERE space_id = ${targetSpace} AND parent_id IS NOT DISTINCT FROM ${newParent} AND id <> ${args.pageId}
    ORDER BY position, created_at
  `
  let before: number | null = null
  let after: number | null = null
  if (args.afterId == null) {
    after = sibs[0]?.position ?? null
  } else {
    const idx = sibs.findIndex((s) => s.id === args.afterId)
    if (idx === -1) throw Object.assign(new Error('afterId is not a sibling'), { statusCode: 400 })
    before = sibs[idx].position
    after = sibs[idx + 1]?.position ?? null
  }
  const position = positionBetween(before, after)

  if (!crossSpace) {
    const [r] = await db.sql<PageRow[]>`
      UPDATE pages SET parent_id = ${newParent}, position = ${position}, updated_at = now()
      WHERE id = ${args.pageId}
      RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    `
    emit({ type: 'page.updated', tenantId: page.tenant_id, pageId: page.id, actorId: args.userId })
    return toPage(r)
  }

  // ── cross-space: subtree follows the page; re-index each; swap space grants ──
  const subtree = [args.pageId, ...(await descendantIds(db, args.pageId))]
  const oldSpace = page.space_id
  const outboxIds: { id: string; pageId: string }[] = []
  const row = await db.tx(async (tx) => {
    await tx`UPDATE pages SET space_id = ${targetSpace}, updated_at = now() WHERE id IN ${tx(subtree)}`
    const [r] = await tx<PageRow[]>`
      UPDATE pages SET parent_id = ${newParent}, position = ${position}, updated_at = now()
      WHERE id = ${args.pageId}
      RETURNING id, tenant_id, space_id, parent_id, title, position, created_at, updated_at
    `
    // Viewer denormalization in Meili changes with the space → re-index the subtree.
    for (const id of subtree) {
      outboxIds.push({ id: await enqueueOutbox(tx, { tenantId: page.tenant_id, pageId: id, operation: 'upsert' }), pageId: id })
    }
    // FGA swap LAST: a throw here rolls back every DB write above (ADR-003).
    await swapSpaceTuples(fga, oldSpace, targetSpace, subtree)
    return r
  })
  for (const o of outboxIds) processOutboxAsync(driver, o.id, { tenantId: page.tenant_id, pageId: o.pageId, operation: 'upsert' })
  emit({ type: 'page.updated', tenantId: page.tenant_id, pageId: page.id, actorId: args.userId })
  return toPage(row as PageRow)
}

// Delete order: FGA first → outbox + DB in same tx.
// Outbox 'delete' entry ensures Meili doc is removed even if Meili is temporarily down.
export async function deletePage(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { pageId: string; userId: string },
): Promise<void> {
  const canManage = await check(fga, `user:${args.userId}`, 'manage', { type: 'page', id: args.pageId })
  if (!canManage) throw Object.assign(new Error('forbidden'), { statusCode: 403 })

  const [meta] = await db.sql<[{ tenant_id: string }]>`SELECT tenant_id FROM pages WHERE id = ${args.pageId}`
  const tenantId = meta?.tenant_id ?? ''

  // ON DELETE CASCADE removes the subtree in the DB, but FGA grants + search docs
  // for descendants must be cleaned too (else ghost auth / stale search). Sweep
  // the page AND all descendants. FGA-first (ADR-003): if a tuple sweep fails the
  // DB row is untouched and the op is retryable.
  const ids = [args.pageId, ...(await descendantIds(db, args.pageId))]
  for (const id of ids) await deleteObjectTuples(fga, `page:${id}`)

  const outboxIds: { id: string; pageId: string }[] = []
  await db.tx(async (tx) => {
    for (const id of ids) {
      outboxIds.push({ id: await enqueueOutbox(tx, { tenantId, pageId: id, operation: 'delete' }), pageId: id })
    }
    await tx`DELETE FROM pages WHERE id = ${args.pageId}` // cascade deletes descendants
  })
  for (const o of outboxIds) processOutboxAsync(driver, o.id, { tenantId, pageId: o.pageId, operation: 'delete' })
  emit({ type: 'page.deleted', tenantId, pageId: args.pageId, actorId: args.userId })
}

// Resolve the request principal (member OR guest) for a page action and bind a
// guest to the page its token was issued for. Returns the FGA subject, the
// attribution id, and (guests) the time context for the share_link condition.
// A guest whose token resource is NOT this page is rejected (resource binding) —
// a token for page A can never read/publish page B.
function principalForPage(req: FastifyRequest, pageId: string): { subject: string; createdBy: string; context?: { current_time: string } } {
  if (req.user) {
    return { subject: `user:${req.user.sub}`, createdBy: `user:${req.user.sub}` }
  }
  if (req.guest) {
    if (req.guest.resource.type !== 'page' || req.guest.resource.id !== pageId) {
      throw Object.assign(new Error('forbidden'), { statusCode: 403 })
    }
    return {
      subject: `share_link:${req.guest.shareLinkId}`,
      createdBy: `guest:${req.guest.shareLinkId}`,
      context: { current_time: new Date().toISOString() },
    }
  }
  throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function pagesPlugin(app: FastifyInstance) {
  app.post<{ Params: { spaceId: string }; Body: { title?: string; parentId?: string | null } }>(
    '/spaces/:spaceId/pages', async (req, reply) => {
      const page = await createPage(req.db, app.fga, app.searchDriver, {
        tenantId: req.tenant.id,
        spaceId: req.params.spaceId,
        userId: req.user.sub,
        title: req.body.title,
        parentId: req.body.parentId ?? null,
      })
      return reply.code(201).send(page)
    },
  )

  // Move/reorder a page. parentId null = top level; afterId null = first child of
  // the target parent. spaceId moves the page (and its subtree) to another space
  // (3b ②); when parentId is given, the parent's space is authoritative.
  app.patch<{ Params: { pageId: string }; Body: { parentId?: string | null; afterId?: string | null; spaceId?: string | null } }>(
    '/pages/:pageId/move', async (req) => {
      return movePage(req.db, app.fga, app.searchDriver, {
        pageId: req.params.pageId,
        userId: req.user.sub,
        parentId: req.body.parentId ?? null,
        afterId: req.body.afterId ?? null,
        spaceId: req.body.spaceId ?? null,
      })
    },
  )

  app.get<{ Params: { spaceId: string } }>('/spaces/:spaceId/pages', async (req) => {
    return listPages(req.db, app.fga, { spaceId: req.params.spaceId, userId: req.user.sub })
  })

  app.get<{ Params: { pageId: string } }>('/pages/:pageId', async (req) => {
    return getPage(req.db, app.fga, { pageId: req.params.pageId, userId: req.user.sub })
  })

  app.patch<{ Params: { pageId: string }; Body: { title: string } }>(
    '/pages/:pageId', async (req) => {
      return updatePage(req.db, app.fga, app.searchDriver, {
        pageId: req.params.pageId,
        userId: req.user.sub,
        title: req.body.title,
      })
    },
  )

  app.delete<{ Params: { pageId: string } }>('/pages/:pageId', async (req, reply) => {
    await deletePage(req.db, app.fga, app.searchDriver, { pageId: req.params.pageId, userId: req.user.sub })
    return reply.code(204).send()
  })

  // Publish the current draft as the new published version (edit-gated). Members or
  // an edit-capable guest (share-link) — same FGA `edit` check either way.
  app.post<{ Params: { pageId: string } }>('/pages/:pageId/publish', { config: { guest: 'edit' } }, async (req) => {
    const p = principalForPage(req, req.params.pageId)
    return publishPage(req.db, app.fga, app.searchDriver, { pageId: req.params.pageId, ...p })
  })

  // Read the published content + draft-vs-published state (view-gated). Members or a
  // view-capable guest. The web view surface and guest share routes render this.
  app.get<{ Params: { pageId: string } }>('/pages/:pageId/published', { config: { guest: 'view' } }, async (req) => {
    const { subject, context } = principalForPage(req, req.params.pageId)
    return getPublished(req.db, app.fga, { pageId: req.params.pageId, subject, context })
  })
}

import type { FastifyInstance } from 'fastify'
import type { Sql } from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, filterAuthorized } from '@wikistead/authz'
import type { TenantDb } from '../db/index.js'

// Watch / notifications / cross-space feed (#320 / ADR-126) — a new subsystem whose READ surfaces are
// permission-critical (the search-leak class). This module owns the three tables (watches / feed_events /
// notifications, migration 060) with the ADR-119 pins discipline: RLS = tenant isolation; MEMBER isolation is
// the app-level `member_sub = <caller sub>` predicate on every query; and the read path re-confirms FGA `view`
// per event AND requires the live resource row (the double gate) so a feed/notification never leaks an
// unviewable change or a stale title. All routes are member-only (no `config.guest` → guests are 401'd).

// #362 / ADR-126 addendum: 'subtree' = an ancestor-page watch matching every descendant page event
// (pages.parent_id chain). Emission scope only — the display gate is unchanged.
export type WatchResourceType = 'page' | 'space' | 'subtree'
const FANOUT_CAP = 2000
// #362: the recursive ancestor walk is bounded so a (theoretically) cyclic parent chain can never
// spin the publish tx — real trees are a few levels deep.
const SUBTREE_MAX_DEPTH = 64

// ── Watches (subscriptions) ──────────────────────────────────────────────────

export interface Watch { id: string; resourceType: WatchResourceType; resourceId: string }

// Subscribe. View-gated with a UNIFORM 404 (non-viewable ≡ nonexistent ≡ cross-tenant — the ADR-119 write gate,
// no existence oracle). Idempotent on the (member, resource) unique key.
export async function createWatch(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; memberSub: string; resourceType: WatchResourceType; resourceId: string },
): Promise<Watch> {
  if (args.resourceType !== 'page' && args.resourceType !== 'space' && args.resourceType !== 'subtree') {
    throw Object.assign(new Error('invalid resource type'), { statusCode: 400 })
  }
  const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 })
  // #362: a 'subtree' watch targets a PAGE id (the ancestor) — same existence + view gate as a page watch.
  const [resource] =
    args.resourceType === 'space'
      ? await db.sql<{ id: string }[]>`SELECT id FROM spaces WHERE id = ${args.resourceId}`
      : await db.sql<{ id: string }[]>`SELECT id FROM pages WHERE id = ${args.resourceId}`
  if (!resource) throw notFound()
  const fgaType = args.resourceType === 'space' ? 'space' : 'page' // subtree anchors are pages
  if (!(await check(fga, `user:${args.memberSub}`, 'view', { type: fgaType, id: args.resourceId }))) throw notFound()

  const [row] = await db.sql<{ id: string }[]>`
    INSERT INTO watches (tenant_id, member_sub, resource_type, resource_id)
    VALUES (${args.tenantId}, ${args.memberSub}, ${args.resourceType}, ${args.resourceId})
    ON CONFLICT (tenant_id, member_sub, resource_type, resource_id) DO NOTHING
    RETURNING id`
  if (row) return { id: row.id, resourceType: args.resourceType, resourceId: args.resourceId }
  const [existing] = await db.sql<{ id: string }[]>`
    SELECT id FROM watches WHERE tenant_id = ${args.tenantId} AND member_sub = ${args.memberSub}
      AND resource_type = ${args.resourceType} AND resource_id = ${args.resourceId}`
  return { id: existing!.id, resourceType: args.resourceType, resourceId: args.resourceId }
}

// Unsubscribe. The member_sub predicate is the member-isolation boundary (another member's watch id → count 0).
export async function deleteWatch(db: TenantDb, args: { id: string; memberSub: string }): Promise<boolean> {
  const r = await db.sql`DELETE FROM watches WHERE id = ${args.id} AND member_sub = ${args.memberSub}`
  return r.count > 0
}

// "Am I watching this?" — for the toggle's initial state. member_sub-scoped; no cross-member read.
export async function isWatching(
  db: TenantDb,
  args: { memberSub: string; resourceType: WatchResourceType; resourceId: string },
): Promise<{ watching: boolean; id: string | null }> {
  const [row] = await db.sql<{ id: string }[]>`
    SELECT id FROM watches WHERE member_sub = ${args.memberSub}
      AND resource_type = ${args.resourceType} AND resource_id = ${args.resourceId}`
  return { watching: !!row, id: row?.id ?? null }
}

// Best-effort cleanup for resource deletion (deletePage/deleteSpace call this inside their tx). Correctness does
// NOT depend on it — the display gate drops orphaned watches/events regardless — it is hygiene (ADR-126 §4).
export async function sweepWatchesForResources(sql: Sql, resourceIds: string[]): Promise<void> {
  if (resourceIds.length === 0) return
  await sql`DELETE FROM watches WHERE resource_id = ANY(${resourceIds})`
}

// ── Emission (in-tx fan-out) ─────────────────────────────────────────────────

// Insert a feed event + fan out notifications to its watchers, INSIDE the caller's tx (durable by construction).
// SET-BASED: one INSERT…SELECT DISTINCT from watches (page-watch OR space-watch), excluding the actor's own sub
// (self-actions appear in the FEED but never as a self-notification, ADR-126 §2). Capped at FANOUT_CAP with a
// LOGGED truncation (never silent). `publishedAt` is the emission guard: a NULL (unpublished page) → no event.
export async function fanOutFeedEvent(
  tx: Sql,
  args: {
    tenantId: string
    eventType: string
    pageId: string | null
    spaceId: string | null
    actor: string // user:<sub> | guest:<id> | anon:<hash>
    publishedAt: Date | null
    log?: { warn: (o: object, msg: string) => void }
  },
): Promise<string | null> {
  if (args.publishedAt == null) return null // existence-hiding: only PUBLISHED pages emit (§2 guard)
  const [ev] = await tx<{ id: string }[]>`
    INSERT INTO feed_events (tenant_id, event_type, page_id, space_id, actor)
    VALUES (${args.tenantId}, ${args.eventType}, ${args.pageId}, ${args.spaceId}, ${args.actor})
    RETURNING id`
  const eventId = ev!.id
  // Exclude the actor when it is a member (user:<sub>); a guest/anon actor matches no member row.
  const actorSub = args.actor.startsWith('user:') ? args.actor.slice(5) : null
  // #362 / ADR-126 addendum: STILL one set-based statement. The added predicates only NARROW emission
  // (mute, member kill switch, event-type masks, subtree scope) — never an authorization input; the
  // display double-gate stays the sole permission authority. The ancestor CTE resolves the event
  // page's parent chain for 'subtree' watches (bounded — SUBTREE_MAX_DEPTH beats a cyclic chain).
  // Mask precedence: a watch's own mask wins; an empty watch mask falls back to the member default;
  // both empty = all types (the permissive pre-#362 behavior).
  const inserted = await tx`
    WITH RECURSIVE ancestors AS (
      SELECT p.id, p.parent_id, 1 AS depth FROM pages p WHERE p.id = ${args.pageId}
      UNION ALL
      SELECT p.id, p.parent_id, a.depth + 1 FROM pages p JOIN ancestors a ON p.id = a.parent_id
      WHERE a.depth < ${SUBTREE_MAX_DEPTH}
    )
    INSERT INTO notifications (tenant_id, member_sub, event_id)
    SELECT DISTINCT ${args.tenantId}, w.member_sub, ${eventId}
    FROM watches w
    LEFT JOIN members m ON m.tenant_id = w.tenant_id AND m.sub = w.member_sub
    WHERE w.tenant_id = ${args.tenantId}
      AND ((w.resource_type = 'page'    AND w.resource_id = ${args.pageId})
        OR (w.resource_type = 'space'   AND w.resource_id = ${args.spaceId})
        OR (w.resource_type = 'subtree' AND ${args.pageId}::text IS NOT NULL AND w.resource_id IN (SELECT id FROM ancestors)))
      AND w.muted IS NOT TRUE
      AND COALESCE(m.notifications_enabled, true)
      AND (CASE WHEN cardinality(w.event_mask) > 0 THEN ${args.eventType} = ANY(w.event_mask)
                WHEN m.default_event_mask IS NOT NULL AND cardinality(m.default_event_mask) > 0 THEN ${args.eventType} = ANY(m.default_event_mask)
                ELSE true END)
      AND (${actorSub}::text IS NULL OR w.member_sub <> ${actorSub})
    LIMIT ${FANOUT_CAP}`
  if (inserted.count >= FANOUT_CAP) {
    const warn = args.log?.warn ?? ((o: object, m: string) => console.warn(m, o)) // never a SILENT cap (§2 / anti-test)
    warn({ eventId, eventType: args.eventType, cap: FANOUT_CAP }, 'notification fan-out hit the cap (truncated)')
  }
  return eventId
}

// #362 / ADR-126 addendum: mention fan-out — NOTIFICATION-ONLY (listFeed excludes 'mention' rows) and
// DELIBERATELY draft-inclusive (no published guard): every recipient is already view-confirmed
// (`mentionableViewers` ∩ the mentioned subs — never a client-sent list), so no existence leak is
// possible, and it matches the existing mention email's draft behavior. Member kill switch + default
// event mask still apply (watch masks don't — a mention is a direct address, not a subscription).
export async function fanOutMention(
  tx: Sql,
  args: { tenantId: string; pageId: string; spaceId: string | null; actor: string; recipientSubs: string[] },
): Promise<string | null> {
  const actorSub = args.actor.startsWith('user:') ? args.actor.slice(5) : null
  const recipients = args.recipientSubs.filter((s) => s !== actorSub)
  if (recipients.length === 0) return null
  const [ev] = await tx<{ id: string }[]>`
    INSERT INTO feed_events (tenant_id, event_type, page_id, space_id, actor)
    VALUES (${args.tenantId}, 'mention', ${args.pageId}, ${args.spaceId}, ${args.actor})
    RETURNING id`
  await tx`
    INSERT INTO notifications (tenant_id, member_sub, event_id)
    SELECT DISTINCT ${args.tenantId}, m.sub, ${ev!.id}
    FROM members m
    WHERE m.tenant_id = ${args.tenantId} AND m.sub = ANY(${recipients})
      AND COALESCE(m.notifications_enabled, true)
      AND (cardinality(m.default_event_mask) = 0 OR 'mention' = ANY(m.default_event_mask))`
  return ev!.id
}

// ── Read path (double-gated: live row JOIN + per-event FGA view) ──────────────

export interface FeedItem {
  id: string
  eventType: string
  pageId: string | null
  spaceId: string | null
  actor: string // opaque; the UI renders a generic "Guest" for any non-user: actor (never the raw id)
  title: string | null
  createdAt: Date
  notificationId?: string
  read?: boolean
  patrolled?: boolean // #326: set on the feed (patrol view) — whether a moderator has marked this event reviewed
}

interface RawRow {
  id: string; event_type: string; page_id: string | null; space_id: string | null
  actor: string; created_at: Date; notification_id?: string; read_at?: Date | null; patrolled_at?: Date | null
}

// Apply BOTH display gates to raw event rows: (1) the live resource must still exist (JOIN by id → its current
// title; a deleted resource's events vanish, no stale title) and (2) the CALLER must have FGA `view` on the
// MOST-SPECIFIC resource — page_id when non-NULL (NEVER space#viewer for a page event: that would leak a
// private page's activity to space viewers, correction 1), else space_id. Events failing either gate are
// silently dropped. Pages batch through filterAuthorized; spaces use a per-id check.
async function gateEvents(db: TenantDb, fga: OpenFgaClient, subject: string, rows: RawRow[]): Promise<FeedItem[]> {
  const pageIds = [...new Set(rows.filter((r) => r.page_id).map((r) => r.page_id!))]
  const spaceIds = [...new Set(rows.filter((r) => !r.page_id && r.space_id).map((r) => r.space_id!))]

  // Gate 1 (live row) + title, per type.
  const pageTitles = new Map<string, string>()
  if (pageIds.length) {
    const prows = await db.sql<{ id: string; title: string }[]>`SELECT id, title FROM pages WHERE id = ANY(${pageIds})`
    for (const p of prows) pageTitles.set(p.id, p.title)
  }
  const spaceTitles = new Map<string, string>()
  if (spaceIds.length) {
    const srows = await db.sql<{ id: string; name: string }[]>`SELECT id, name FROM spaces WHERE id = ANY(${spaceIds})`
    for (const s of srows) spaceTitles.set(s.id, s.name)
  }
  // Gate 2 (FGA view) — pages batched, spaces per-id.
  const viewablePages = pageIds.length ? new Set(await filterAuthorized(fga, subject, 'view', [...pageTitles.keys()])) : new Set<string>()
  const viewableSpaces = new Set<string>()
  for (const sid of spaceTitles.keys()) {
    if (await check(fga, subject, 'view', { type: 'space', id: sid })) viewableSpaces.add(sid)
  }

  const out: FeedItem[] = []
  for (const r of rows) {
    if (r.page_id) {
      if (!pageTitles.has(r.page_id) || !viewablePages.has(r.page_id)) continue // gate 1 or 2 failed → drop
      out.push(toItem(r, pageTitles.get(r.page_id)!))
    } else if (r.space_id) {
      if (!spaceTitles.has(r.space_id) || !viewableSpaces.has(r.space_id)) continue
      out.push(toItem(r, spaceTitles.get(r.space_id)!))
    } // an event with neither id is not display-gateable → drop (defensive)
  }
  return out
}
function toItem(r: RawRow, title: string): FeedItem {
  const item: FeedItem = { id: r.id, eventType: r.event_type, pageId: r.page_id, spaceId: r.space_id, actor: r.actor, title, createdAt: r.created_at }
  if (r.notification_id !== undefined) { item.notificationId = r.notification_id; item.read = r.read_at != null }
  if (r.patrolled_at !== undefined) item.patrolled = r.patrolled_at != null // #326: the feed row's patrol state
  return item
}

// #326 / ADR-142 (C-1 patrol): gate a SINGLE feed event for a patrol op. Loads the live row (the reserved
// connection is tenant-scoped by RLS → a cross-tenant / missing id yields nothing → 404) and VIEW-confirms it
// via the same gateEvents used by the feed (non-viewable → dropped → 404) — BEFORE any capability check. So a
// caller with `manage` on a space but no `view` on a strict-private page's event gets a uniform 404, never a
// write-side existence oracle (the mirror of the read-feed gate; reviewer's blocking fix). Returns the resource
// ref to capability-check, or null (→ 404).
async function gatePatrolTarget(
  db: TenantDb,
  fga: OpenFgaClient,
  subject: string,
  feedEventId: string,
): Promise<{ type: 'page' | 'space'; id: string } | null> {
  const rows = await db.sql<RawRow[]>`
    SELECT id, event_type, page_id, space_id, actor, created_at FROM feed_events WHERE id = ${feedEventId}`
  if (!rows.length) return null
  const [item] = await gateEvents(db, fga, subject, rows) // live-row + FGA view (most-specific resource)
  if (!item) return null
  return item.pageId ? { type: 'page', id: item.pageId } : item.spaceId ? { type: 'space', id: item.spaceId } : null
}

// #330 / ADR-141: patrol is a MODERATION verb. A page event passes on `moderate` OR `manage` (moderate does
// not imply page-level manage_direct and vice versa); a space event passes on space `moderator` (which
// already unions manager — `moderator: [...] or manager`). Gate order unchanged: view-confirm → uniform
// 404 → capability 403.
async function canPatrol(fga: OpenFgaClient, subject: string, ref: { type: 'page' | 'space'; id: string }): Promise<boolean> {
  // space#moderator already unions manager, so the single 'moderate' capability check suffices for spaces.
  if (ref.type === 'space') return check(fga, subject, 'moderate', ref)
  const [moderate, manage] = await Promise.all([
    check(fga, subject, 'moderate', ref),
    check(fga, subject, 'manage', ref),
  ])
  return moderate || manage
}

// Mark a feed event as patrolled (reviewed). member-only. Gate order (reviewer): view-confirm → uniform 404 →
// capability 403. Patrol requires `moderate`/`manage` (#330 widened the original manage-only gate). Idempotent upsert.
export async function markPatrolled(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; subject: string; memberSub: string; feedEventId: string },
): Promise<void> {
  const ref = await gatePatrolTarget(db, fga, args.subject, args.feedEventId)
  if (!ref) throw Object.assign(new Error('not found'), { statusCode: 404 }) // missing / cross-tenant / not viewable
  if (!(await canPatrol(fga, args.subject, ref))) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  await db.sql`
    INSERT INTO patrolled_events (tenant_id, feed_event_id, patrolled_by)
    VALUES (${args.tenantId}, ${args.feedEventId}, ${args.memberSub})
    ON CONFLICT (tenant_id, feed_event_id) DO UPDATE SET patrolled_by = ${args.memberSub}, patrolled_at = now()`
}

// Unmark (remove a patrol). Same gate order (view → 404 → moderate/manage 403), then delete.
export async function unmarkPatrolled(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; subject: string; feedEventId: string },
): Promise<void> {
  const ref = await gatePatrolTarget(db, fga, args.subject, args.feedEventId)
  if (!ref) throw Object.assign(new Error('not found'), { statusCode: 404 })
  if (!(await canPatrol(fga, args.subject, ref))) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
  await db.sql`DELETE FROM patrolled_events WHERE tenant_id = ${args.tenantId} AND feed_event_id = ${args.feedEventId}`
}

// Cross-space activity feed (member-only). Over-fetch to absorb gate drops (the stage1/stage2 lesson).
export async function listFeed(
  db: TenantDb,
  fga: OpenFgaClient,
  // #326: `unpatrolledOnly` keeps only events with no patrol mark (the Recent Changes "needs review" filter);
  // the LEFT JOIN also carries each item's `patrolled` state for display. The FGA view gate is unchanged (the
  // patrol join adds no new page ids — the #320 two-stage gate still runs).
  args: { subject: string; spaceId?: string | null; before?: string | null; limit?: number; unpatrolledOnly?: boolean },
): Promise<FeedItem[]> {
  const limit = Math.min(args.limit ?? 30, 100)
  const overfetch = limit * 4
  const unpatrolled = args.unpatrolledOnly === true
  // #362 E2: the cursor pages on the ORDER BY tuple (created_at, id) — `id < before` alone is
  // non-monotonic for TEXT uuids (rows dropped/duplicated past page 1). The API still passes the last
  // item's id; resolve its created_at here. An unknown id = no cursor (first page).
  const before = args.before || null
  const [cur] = before ? await db.sql<{ created_at: Date }[]>`SELECT created_at FROM feed_events WHERE id = ${before}` : []
  const curAt = cur?.created_at ?? null
  const rows = args.spaceId
    ? await db.sql<RawRow[]>`
        SELECT fe.id, fe.event_type, fe.page_id, fe.space_id, fe.actor, fe.created_at, pe.patrolled_at
        FROM feed_events fe LEFT JOIN patrolled_events pe ON pe.feed_event_id = fe.id
        WHERE fe.space_id = ${args.spaceId}
          AND (${curAt}::timestamptz IS NULL OR (fe.created_at, fe.id) < (${curAt}, ${before}))
          AND (${unpatrolled}::bool IS NOT TRUE OR pe.patrolled_at IS NULL)
          AND fe.event_type <> 'mention'
        ORDER BY fe.created_at DESC, fe.id DESC LIMIT ${overfetch}`
    : await db.sql<RawRow[]>`
        SELECT fe.id, fe.event_type, fe.page_id, fe.space_id, fe.actor, fe.created_at, pe.patrolled_at
        FROM feed_events fe LEFT JOIN patrolled_events pe ON pe.feed_event_id = fe.id
        WHERE (${curAt}::timestamptz IS NULL OR (fe.created_at, fe.id) < (${curAt}, ${before}))
          AND (${unpatrolled}::bool IS NOT TRUE OR pe.patrolled_at IS NULL)
          AND fe.event_type <> 'mention'
        ORDER BY fe.created_at DESC, fe.id DESC LIMIT ${overfetch}`
  // #362: `mention` rows are NOTIFICATION-ONLY (personal, not space activity) — excluded above in BOTH
  // branches; listNotifications keeps them (and still double-gates them like everything else).
  return (await gateEvents(db, fga, args.subject, rows)).slice(0, limit)
}

// The member's inbox — per-member rows, but STILL double-gated at display (a revoked-access notification
// disappears silently; the row stays). member_sub predicate is the isolation boundary.
export async function listNotifications(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { memberSub: string; before?: string | null; limit?: number },
): Promise<FeedItem[]> {
  const limit = Math.min(args.limit ?? 30, 100)
  // #362 E2: tuple cursor on the ORDER BY (n.created_at, n.id) — same non-monotonic-id fix as listFeed.
  const before = args.before || null
  const [cur] = before
    ? await db.sql<{ created_at: Date }[]>`SELECT created_at FROM notifications WHERE id = ${before} AND member_sub = ${args.memberSub}`
    : []
  const curAt = cur?.created_at ?? null
  const rows = await db.sql<RawRow[]>`
    SELECT n.id AS notification_id, n.read_at, e.id, e.event_type, e.page_id, e.space_id, e.actor, e.created_at
    FROM notifications n JOIN feed_events e ON e.id = n.event_id
    WHERE n.member_sub = ${args.memberSub}
      AND (${curAt}::timestamptz IS NULL OR (n.created_at, n.id) < (${curAt}, ${before}))
    ORDER BY n.created_at DESC, n.id DESC LIMIT ${limit * 4}`
  // The caller gates against their own view (a notification is per-member; subject = the member).
  return (await gateEvents(db, fga, `user:${args.memberSub}`, rows)).slice(0, limit)
}

// #362: the watch-LIST surface (bell → "watching"). Titles resolve at display from the live rows and
// are VIEW-FILTERED (the pins discipline): a watch whose target the member can no longer view renders
// untitled/inert (title null) — never a title oracle; unwatch stays possible. member_sub predicate =
// the isolation boundary.
export interface ResolvedWatch { id: string; resourceType: WatchResourceType; resourceId: string; eventMask: string[]; muted: boolean; title: string | null }
export async function listWatchesResolved(db: TenantDb, fga: OpenFgaClient, args: { memberSub: string }): Promise<ResolvedWatch[]> {
  const rows = await db.sql<{ id: string; resource_type: WatchResourceType; resource_id: string; event_mask: string[]; muted: boolean }[]>`
    SELECT id, resource_type, resource_id, event_mask, muted FROM watches WHERE member_sub = ${args.memberSub} ORDER BY created_at DESC`
  const pageIds = [...new Set(rows.filter((r) => r.resource_type !== 'space').map((r) => r.resource_id))]
  const spaceIds = [...new Set(rows.filter((r) => r.resource_type === 'space').map((r) => r.resource_id))]
  const pageTitles = new Map<string, string>()
  if (pageIds.length) for (const p of await db.sql<{ id: string; title: string }[]>`SELECT id, title FROM pages WHERE id = ANY(${pageIds})`) pageTitles.set(p.id, p.title)
  const spaceTitles = new Map<string, string>()
  if (spaceIds.length) for (const s of await db.sql<{ id: string; name: string }[]>`SELECT id, name FROM spaces WHERE id = ANY(${spaceIds})`) spaceTitles.set(s.id, s.name)
  const subject = `user:${args.memberSub}`
  const viewablePages = pageIds.length ? new Set(await filterAuthorized(fga, subject, 'view', [...pageTitles.keys()])) : new Set<string>()
  const viewableSpaces = new Set<string>()
  for (const sid of spaceTitles.keys()) if (await check(fga, subject, 'view', { type: 'space', id: sid })) viewableSpaces.add(sid)
  return rows.map((r) => ({
    id: r.id,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    eventMask: r.event_mask,
    muted: r.muted,
    title: r.resource_type === 'space'
      ? (viewableSpaces.has(r.resource_id) ? spaceTitles.get(r.resource_id) ?? null : null)
      : (viewablePages.has(r.resource_id) ? pageTitles.get(r.resource_id) ?? null : null),
  }))
}

// #362: "mark all read" — the badge's self-service reset (also mops up gate-dropped residue after a
// revocation). member_sub predicate = the isolation boundary; touches ONLY the caller's rows.
export async function markAllNotificationsRead(db: TenantDb, args: { memberSub: string }): Promise<number> {
  const r = await db.sql`UPDATE notifications SET read_at = now() WHERE member_sub = ${args.memberSub} AND read_at IS NULL`
  return r.count
}

// #362 E1: revocation watch sweep. When view is REVOKED (grant removal / restrict / private toggle /
// member removal), the member's watch rows would otherwise keep inflating their unread badge forever
// (fan-out keeps inserting; the gated list stays empty). For each watch on the affected resources,
// re-check the watcher's `view` and delete ONLY the losers — a watcher whose view survives via another
// path (group, public, direct grant) keeps their watch. Hygiene, not authz: the display double-gate
// remains the correctness bastion, so an over/under-sweep can never leak. Distinct from the BLIND
// `sweepWatchesForResources` (resource DELETION — every watch dies with the resource). Bounded + logged.
const SWEEP_CAP = 500
export async function sweepUnviewableWatches(
  db: TenantDb,
  fga: OpenFgaClient,
  resourceIds: string[],
  log?: { warn: (o: object, msg: string) => void },
): Promise<number> {
  if (resourceIds.length === 0) return 0
  const rows = await db.sql<{ id: string; member_sub: string; resource_type: WatchResourceType; resource_id: string }[]>`
    SELECT id, member_sub, resource_type, resource_id FROM watches
    WHERE resource_id = ANY(${resourceIds}) LIMIT ${SWEEP_CAP + 1}`
  if (rows.length > SWEEP_CAP) {
    const warn = log?.warn ?? ((o: object, m: string) => console.warn(m, o))
    warn({ resourceIds: resourceIds.length, cap: SWEEP_CAP }, 'watch sweep hit the cap; remainder left to the display gate')
  }
  const lost: string[] = []
  for (const w of rows.slice(0, SWEEP_CAP)) {
    const fgaType = w.resource_type === 'space' ? 'space' : 'page' // subtree anchors are pages
    if (!(await check(fga, `user:${w.member_sub}`, 'view', { type: fgaType, id: w.resource_id }))) lost.push(w.id)
  }
  if (lost.length) await db.sql`DELETE FROM watches WHERE id = ANY(${lost})`
  return lost.length
}

// The bell badge count. RAW per-member unread count (a bare number names no resource → not a leak; correction
// 3b). It may briefly exceed the gated list after a revocation; the list self-corrects when opened.
export async function unreadCount(db: TenantDb, args: { memberSub: string }): Promise<number> {
  const [row] = await db.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM notifications WHERE member_sub = ${args.memberSub} AND read_at IS NULL`
  return row?.n ?? 0
}

// Mark one notification read (member-scoped). Returns false (→404) for another member's / a nonexistent id.
export async function markNotificationRead(db: TenantDb, args: { id: string; memberSub: string }): Promise<boolean> {
  const r = await db.sql`
    UPDATE notifications SET read_at = now() WHERE id = ${args.id} AND member_sub = ${args.memberSub} AND read_at IS NULL`
  return r.count > 0
}

// ── Fastify plugin (member-only) ─────────────────────────────────────────────
export async function notificationsPlugin(app: FastifyInstance) {
  const subjectOf = (sub: string) => `user:${sub}`

  app.get<{ Querystring: { resourceType?: WatchResourceType; resourceId?: string } }>('/watches', async (req) => {
    // With a resource → the toggle's state; without → the member's watch list.
    if (req.query.resourceType && req.query.resourceId) {
      return isWatching(req.db, { memberSub: req.user.sub, resourceType: req.query.resourceType, resourceId: req.query.resourceId })
    }
    return listWatchesResolved(req.db, app.fga, { memberSub: req.user.sub })
  })

  // #362: per-watch preferences — mute + event mask. member_sub predicate = the isolation boundary
  // (another member's watch id → 0 rows → 404). Emission-narrowing only; no authz surface.
  app.patch<{ Params: { id: string }; Body: { muted?: boolean; eventMask?: string[] } }>('/watches/:id', async (req, reply) => {
    const muted = typeof req.body?.muted === 'boolean' ? req.body.muted : null
    const mask = Array.isArray(req.body?.eventMask) ? req.body.eventMask.map(String).slice(0, 32) : null
    const r = await req.db.sql`
      UPDATE watches SET
        muted = COALESCE(${muted}, muted),
        event_mask = COALESCE(${mask}::text[], event_mask)
      WHERE id = ${req.params.id} AND member_sub = ${req.user.sub}`
    if (r.count === 0) return reply.code(404).send({ error: 'not found' })
    return reply.code(204).send()
  })

  app.post<{ Body: { resourceType: WatchResourceType; resourceId: string } }>('/watches', async (req, reply) => {
    const w = await createWatch(req.db, app.fga, {
      tenantId: req.tenant.id, memberSub: req.user.sub,
      resourceType: req.body?.resourceType, resourceId: String(req.body?.resourceId ?? ''),
    })
    return reply.code(201).send(w)
  })

  app.delete<{ Params: { id: string } }>('/watches/:id', async (req, reply) => {
    const removed = await deleteWatch(req.db, { id: req.params.id, memberSub: req.user.sub })
    if (!removed) return reply.code(404).send({ error: 'not found' })
    return reply.code(204).send()
  })

  app.get<{ Querystring: { spaceId?: string; before?: string; unpatrolled?: string } }>('/feed', async (req) =>
    listFeed(req.db, app.fga, { subject: subjectOf(req.user.sub), spaceId: req.query.spaceId ?? null, before: req.query.before ?? null, unpatrolledOnly: req.query.unpatrolled === 'true' }))

  // #326 / ADR-142 (C-1 patrol): mark / unmark a feed event as reviewed. Member-only (no guest config → a guest
  // is structurally 401, like /feed). The gate order (view-confirm → 404 → capability 403) lives in mark/unmark.
  app.post<{ Params: { eventId: string } }>('/feed/:eventId/patrol', async (req, reply) => {
    try {
      await markPatrolled(req.db, app.fga, { tenantId: req.tenant.id, subject: subjectOf(req.user.sub), memberSub: req.user.sub, feedEventId: req.params.eventId })
      return reply.code(204).send()
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode
      if (sc === 404 || sc === 403) return reply.code(sc).send({ error: sc === 404 ? 'not found' : 'forbidden' })
      throw e
    }
  })
  app.delete<{ Params: { eventId: string } }>('/feed/:eventId/patrol', async (req, reply) => {
    try {
      await unmarkPatrolled(req.db, app.fga, { tenantId: req.tenant.id, subject: subjectOf(req.user.sub), feedEventId: req.params.eventId })
      return reply.code(204).send()
    } catch (e) {
      const sc = (e as { statusCode?: number }).statusCode
      if (sc === 404 || sc === 403) return reply.code(sc).send({ error: sc === 404 ? 'not found' : 'forbidden' })
      throw e
    }
  })

  app.get<{ Querystring: { before?: string } }>('/notifications', async (req) =>
    listNotifications(req.db, app.fga, { memberSub: req.user.sub, before: req.query.before ?? null }))

  app.get('/notifications/unread-count', async (req) => ({ count: await unreadCount(req.db, { memberSub: req.user.sub }) }))

  app.post<{ Params: { id: string } }>('/notifications/:id/read', async (req, reply) => {
    const ok = await markNotificationRead(req.db, { id: req.params.id, memberSub: req.user.sub })
    if (!ok) return reply.code(404).send({ error: 'not found' })
    return reply.code(204).send()
  })

  // #362: badge self-service reset — caller's rows only (member_sub predicate inside).
  app.post('/notifications/read-all', async (req) => ({ marked: await markAllNotificationsRead(req.db, { memberSub: req.user.sub }) }))
}

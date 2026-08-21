import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, writeTuples, deleteTuples, isAlreadyConverged, runInAuthzScope, SYSTEM_SCOPE } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
import type { Capability, ResourceRef } from '@wikistead/types'
import { pool } from '../db/pool.js'
import { reportLinkVisit } from '../funnel/sink.js'
import { withTenantTx } from '../db/index.js' // #382
import { resolveTenantFromHost, loadTenant } from '../tenant.js'
import type { TenantDb } from '../db/index.js'
import { hashSharePassword, verifySharePassword } from './share-link-password.js'
import type IORedis from 'ioredis'

// Rate-limit windows for the public share-link exchange (#107 / ADR-026). Starting points —
// tune from real traffic. The per-IP bucket is the brute-force/DoS guard; the per-link bucket
// caps hammering one id. Both are fixed-window counters in the shared Valkey (cross-replica).
// Env-overridable (ADR-026: the numbers are tuned from real traffic; e2e raises them so the
// whole suite hitting the endpoint from one localhost IP doesn't trip the per-IP bucket).
const EXCHANGE_RL_WINDOW_S = 60
const EXCHANGE_RL_IP_MAX = Number(process.env.EXCHANGE_RL_IP_MAX ?? 30)
const EXCHANGE_RL_LINK_MAX = Number(process.env.EXCHANGE_RL_LINK_MAX ?? 10)

// #233 / ADR-107 (comment 967): the DEDICATED wrong-password throttle. per (link, IP) 5/min AND per link
// 30/hour, fixed-window, bumped ONLY on a wrong/missing password. Confirmed values (coded like EXCHANGE_RL_*).
const PW_RL_WINDOW_S = 60
const PW_RL_IP_MAX = 5
const PW_RL_HOUR_S = 3600
const PW_RL_LINK_MAX = 30

// Fixed-window counter: INCR the key, set the TTL on the first hit, return whether still within
// `max`. One round-trip + an occasional EXPIRE; idempotent under concurrency (INCR is atomic).
async function bumpRateBucket(valkey: IORedis, key: string, max: number): Promise<boolean> {
  const n = await valkey.incr(key)
  if (n === 1) await valkey.expire(key, EXCHANGE_RL_WINDOW_S)
  return n <= max
}
// #233: bump with an explicit window (the wrong-password buckets use 60s vs 3600s), else identical.
async function bumpDurationBucket(valkey: IORedis, key: string, windowS: number): Promise<boolean> {
  const n = await valkey.incr(key)
  if (n === 1) await valkey.expire(key, windowS)
  return n <= (windowS === PW_RL_HOUR_S ? PW_RL_LINK_MAX : PW_RL_IP_MAX)
}
// #233: READ-ONLY check (no INCR) — is this wrong-password bucket already AT its max? Used in the
// preHandler to reject a brute-forcer before processing; the count is only ever raised by a wrong password.
async function peekRateBucket(valkey: IORedis, key: string, max: number): Promise<boolean> {
  const v = await valkey.get(key)
  return (v == null ? 0 : Number(v)) < max
}

interface ShareLinkRow {
  id: string
  tenant_id: string
  resource_type: string
  resource_id: string
  capability: string
  expires_at: Date | null
  created_by: string
  created_at: Date
  revoked_at: Date | null
  password_hash?: string | null // #233: null = no password
}
export interface ShareLink {
  id: string
  resource: ResourceRef
  capability: Capability
  expiresAt: string | null
  createdAt: string
}
function toShareLink(r: ShareLinkRow): ShareLink {
  return {
    id: r.id,
    resource: { type: r.resource_type as ResourceRef['type'], id: r.resource_id },
    capability: r.capability as Capability,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  }
}

// The FGA relation a share link writes, by resource kind + capability:
//  - page: view -> 'view_direct', edit -> 'edit_direct' (#218/ADR-103: `view`/`edit` are computed; a direct
//    grant goes to the cascading `*_direct` leaf). Links carry view/edit ONLY — commenting is a
//    RESOURCE setting (space#comment_open), NOT a link capability, so a guest comments via a VIEW
//    link + comments being open, never via a comment link.
//  - space: view -> 'viewer', edit -> 'editor' (#274 / ADR-135). The header used to say a space link
//    was read-only and an edit one was rejected, which was true under ADR-038 and stopped being true
//    when the editor split landed — and the stale line is not harmless: it is what made collab's
//    demotion of space tokens to `view` look correct for months (#812, found on a device, not in a
//    review). The body below is the statement of record.
function relationForResource(type: ResourceRef['type'], capability: Capability): 'view_direct' | 'edit_direct' | 'viewer' | 'editor' {
  if (type === 'space') {
    // #274 / ADR-135: a space EDIT link writes `space#editor` (share_link + the non_expired twin are its
    // ONLY direct types post-split) — page#edit_from_space inherits it to every published, non-private
    // page. viewer_member references editor_MEMBER, so this can never reach space templates. Issuance is
    // additionally entitlement-gated (spaceEditLink, 402) in createShareLink.
    if (capability === 'edit') return 'editor'
    if (capability !== 'view') throw Object.assign(new Error('space links are view or edit'), { statusCode: 400 })
    return 'viewer'
  }
  // page: view / edit are shareable; comment is the resource's setting (#100), manage is not. #218 / ADR-103:
  // a page share-link grant is a DIRECT grant → the `*_direct` leaf (so a folder link cascades to children,
  // and `edit`/`view_base` being computed can't take a direct write). Revoke/sweep read the same leaf.
  if (capability === 'view') return 'view_direct'
  if (capability === 'edit') return 'edit_direct'
  throw Object.assign(new Error('capability must be view or edit'), { statusCode: 400 })
}

const guestCfg = {
  secret: process.env.GUEST_TOKEN_SECRET!,
  ttlSeconds: Number(process.env.GUEST_TOKEN_TTL_SECONDS ?? 300),
}

// ── Service functions ──────────────────────────────────────────────────────


// #420 3b: the share-class gate for a page OR space resource. On a PAGE the `share` verb suffices
// (its manage superset arm admits managers); on a SPACE the capability relation (sharer) has NO
// manager union by design (managers bypass via page.manage), so space-level share operations accept
// share OR manage — a manager keeps every pre-split ability.
async function requireShareOnResource(fga: OpenFgaClient, userId: string, resource: ResourceRef): Promise<void> {
  if (await check(fga, `user:${userId}`, 'share', resource)) return
  if (resource.type === 'space' && (await check(fga, `user:${userId}`, 'manage', resource))) return
  throw Object.assign(new Error('forbidden'), { statusCode: 403 })
}


// Rider 2 (#420): a TRASHED page is uniformly absent to share-class operations (the model
// keeps admin verbs alive on trash for restore/purge, so the route is the fortress here).
async function requirePageNotTrashed(db: TenantDb, resource: ResourceRef): Promise<void> {
  if (resource.type !== 'page') return
  const [row] = await db.sql<[{ deleted_root_id: string | null }?]>`SELECT deleted_root_id FROM pages WHERE id = ${resource.id}`
  if (!row || row.deleted_root_id) throw Object.assign(new Error('not found'), { statusCode: 404 })
}

// Create a share link for a page or a space (#274). Requires the SHARE class on the resource
// (`requireShareOnResource`) — issuing an anonymous link is an administrative act, but since #420 3b
// that authority is `share`, not `manage`; a manager still passes through page#share's superset arm.
// #833: this line said `manage`, which is stricter than what the code has enforced since the split.
export async function createShareLink(
  db: TenantDb,
  fga: OpenFgaClient,
  args: {
    tenantId: string
    plan: string
    userId: string
    resource: ResourceRef
    capability: Capability
    expiresInSeconds: number | null
    password?: string | null // #233 / ADR-107: optional password (set at issuance only)
  },
): Promise<ShareLink> {
  if (args.resource.type !== 'page' && args.resource.type !== 'space') {
    throw Object.assign(new Error('only page or space links are supported'), { statusCode: 400 })
  }
  // Entitlement gate (issuance only): blocked plans cannot mint new links, but
  // already-issued links keep working. Free includes guest access (the hook).
  if (!resolveEntitlements(args.plan).guestAccess) {
    throw Object.assign(new Error('share links not available on this plan'), { statusCode: 402 })
  }
  // Relation by kind (page view/edit, space viewer/editor since #274).
  const relation = relationForResource(args.resource.type, args.capability)

  // #420 3b: share-class authority issues anonymous links (manage keeps passing — see the helper).
  await requireShareOnResource(fga, args.userId, args.resource)
  await requirePageNotTrashed(db, args.resource) // Rider 2

  // #274 / ADR-135: a space EDIT link (the anonymous-wiki face) is its own lever — Cloud paid tiers
  // only, self-host unlimited. Same 402 convention; existing links are untouched by a downgrade.
  // AFTER the share gate: someone without share-class authority gets a uniform 403 and learns
  // nothing about the plan.
  if (args.resource.type === 'space' && args.capability === 'edit' && !resolveEntitlements(args.plan).spaceEditLink) {
    throw Object.assign(new Error('space edit links not available on this plan'), { statusCode: 402 })
  }

  const expiresAt = args.expiresInSeconds != null ? new Date(Date.now() + args.expiresInSeconds * 1000) : null
  // #233: hash the optional password (scrypt + salt) OUTSIDE the tx (KDF is slow); a blank/whitespace
  // password is treated as none. Plaintext never touches the DB.
  const pw = args.password?.trim() ? args.password : null
  const passwordHash = pw ? await hashSharePassword(pw) : null

  // INSERT (DB-generated v4 id) + FGA grant in one tx; FGA failure rolls back. resource_type
  // is stored verbatim so revoke deletes exactly the right tuple (1 link = 1 resource).
  const row = await db.tx(async (tx) => {
    const [r] = await tx<ShareLinkRow[]>`
      INSERT INTO share_links (tenant_id, resource_type, resource_id, capability, expires_at, created_by, password_hash)
      VALUES (${args.tenantId}, ${args.resource.type}, ${args.resource.id}, ${args.capability},
              ${expiresAt}, ${`user:${args.userId}`}, ${passwordHash})
      RETURNING id, tenant_id, resource_type, resource_id, capability, expires_at, created_by, created_at, revoked_at
    `
    await writeTuples(fga, [
      {
        user: `share_link:${r.id}`,
        relation,
        object: `${args.resource.type}:${args.resource.id}`, // page:<id> | space:<id>
        // Time-bounded link -> non_expired condition; permanent -> no condition.
        ...(expiresAt
          ? { condition: { name: 'non_expired', context: { expires_at: expiresAt.toISOString() } } }
          : {}),
      },
    ])
    return r
  })
  return toShareLink(row as ShareLinkRow)
}

/** #623: how many share links one response may carry. */
export const SHARE_LINKS_PAGE_LIMIT = 100

export interface ShareLinksPage { links: ShareLink[]; nextCursor: string | null }

// List a resource's active share links (page or space). The SHARE class is required — `share` on a page,
// `share` or `manage` on a space (#420 3b, `requireShareOnResource`). #833: this line said `manage` too,
// and it is the costliest of the three: a reader deciding who may see a resource's links — and an
// unpassworded link id IS its credential (app.ts) — would have believed the answer was administrators.
// #856: this block sat above SHARE_LINKS_PAGE_LIMIT, nine lines and two declarations away from
// what it describes — far enough that a reader scanning to the signature never met it.
export async function listShareLinks(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { resource: ResourceRef; userId: string; limit?: number; cursor?: string },
): Promise<ShareLinksPage> {
  await requireShareOnResource(fga, args.userId, args.resource) // #420 3b
  await requirePageNotTrashed(db, args.resource) // Rider 2
  // #623: one row per live link, and nothing prunes them — a busy page accumulates. Two routes read
  // through here (the page's links and the space's), so both are bounded by this one query.
  //
  // The cursor carries an epoch rather than a formatted timestamp: a parameter loses its microseconds
  // on the way in, because the driver parses it into a JS Date. This walk is DESC, the direction that
  // SKIPS — a link created between the truncated instant and the true one would appear on no page, and
  // a share link missing from the list of live links is one nobody knows to revoke.
  //
  // `id` joins the ORDER BY: links are minted in bulk by scripted setup, and two stamped in the same
  // instant would straddle a boundary for ever — one repeated, one never seen.
  const limit = Math.min(500, Math.max(1, args.limit ?? SHARE_LINKS_PAGE_LIMIT))
  const bar = args.cursor?.indexOf('|') ?? -1
  const after = args.cursor && bar > 0 ? { at: args.cursor.slice(0, bar), id: args.cursor.slice(bar + 1) } : null
  const rows = await db.sql<(ShareLinkRow & { cursor_at: string })[]>`
    SELECT id, tenant_id, resource_type, resource_id, capability, expires_at, created_by, created_at, revoked_at,
           extract(epoch from created_at)::text AS cursor_at
    FROM share_links
    WHERE resource_type = ${args.resource.type} AND resource_id = ${args.resource.id} AND revoked_at IS NULL
      ${after ? db.sql`AND (created_at, id) < (to_timestamp(${after.at}::numeric), ${after.id})` : db.sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  return {
    links: page.map(toShareLink),
    nextCursor: hasMore && last ? `${last.cursor_at}|${last.id}` : null,
  }
}

/**
 * Every live link on a resource, by walking the pages.
 *
 * The dialog needs the whole set: it is the only place a link can be revoked, and a link that is not on
 * the list is one nobody knows to take away. The walk is written once, and its loop condition is
 * `nextCursor` — never "the page came back empty".
 */
export async function listAllShareLinks(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { resource: ResourceRef; userId: string },
): Promise<ShareLink[]> {
  const out: ShareLink[] = []
  let cursor: string | undefined
  do {
    const page: ShareLinksPage = await listShareLinks(db, fga, { ...args, ...(cursor ? { cursor } : {}) })
    out.push(...page.links)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return out
}

// Revoke = delete the FGA tuple (instant; the authority) + stamp revoked_at.
export async function revokeShareLink(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { id: string; userId: string; tenantId: string },
): Promise<void> {
  const [row] = await db.sql<ShareLinkRow[]>`
    SELECT id, tenant_id, resource_type, resource_id, capability, expires_at, created_by, created_at, revoked_at
    FROM share_links WHERE id = ${args.id}
  `
  if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })

  const resource: ResourceRef = { type: row.resource_type as ResourceRef['type'], id: row.resource_id }
  await requireShareOnResource(fga, args.userId, resource) // #420 3b: revoking a link is share-class too
  await requirePageNotTrashed(db, resource) // Rider 2: a trashed page is uniformly absent

  // Idempotent: the grant may already be gone (double-revoke, or DB/FGA drift).
  // Either way the desired end state is "tuple absent + revoked_at set", so a
  // missing tuple is success, not an error.
  try {
    await deleteTuples(fga, [
      {
        user: `share_link:${row.id}`,
        relation: relationForResource(resource.type, row.capability as Capability),
        object: `${resource.type}:${row.resource_id}`, // page:<id> | space:<id>
      },
    ])
  } catch (err) {
    if (!isAlreadyConverged(err)) throw err
  }
  await db.sql`UPDATE share_links SET revoked_at = now() WHERE id = ${args.id}`
  emit({ type: 'share_link.revoked', tenantId: args.tenantId, shareLinkId: row.id, pageId: row.resource_id, actorId: args.userId })
}

export interface RevokeShareLinksResult {
  revoked: { id: string; pageId: string }[]; // FGA-cleared + DB-revoked (emit these AFTER the caller commits)
  failed: string[]; // link ids whose FGA delete errored — left revoked_at IS NULL, recoverable on a re-run
}

// #109 Fix A (comment 768) + comment 785 (partial-failure detectability): revoke EVERY active share link on
// a resource. Used when a page is made private — a page share link is a DIRECT grant (share_link:<id> →
// view/edit on page:<id>), NOT routed through `viewer from space`, so `but not private` does NOT cut it: a
// link issued before privatisation would keep working. Revoke (not just strip the tuple) so DB row + FGA +
// emit stay consistent — no zombie link that looks active in listPageGrants but 404s.
//
// comment 785 hardening (why NOT one PG tx with the private marker): the private marker is an FGA write
// (writeTuples PRIVATE_MARKER) — NOT transactional — so it cannot roll back with a PG tx, and it MUST stay
// (fail-safe: private = space-cut is the security priority; a missed link-revoke is not danger EXPANSION).
// Folding this into setPagePrivate's tx would also roll back the outbox reindex on a revoke failure, leaving
// the private page indexed as public — a worse leak. So the private-ization commits FIRST (marker + public
// strip + outbox), then this runs. Here we make the DB side ATOMIC and the FGA side DETECTABLE/RECOVERABLE:
//   1. delete each link's FGA tuple first (idempotent — "did not exist" counts as cleared);
//   2. mark revoked_at for the FGA-cleared links in ONE tx (no partial DB state — comment 785 #1 intent);
//   3. an FGA delete that ERRORS is logged and its link left revoked_at IS NULL (comment 785 #3) — the next
//      privatise/sweep re-selects it (revoked_at IS NULL filter) and retries idempotently, no double-process.
// The caller emits `share_link.revoked` AFTER it commits (comment 785 #2 — never emit on a rolled-back tx).
export async function revokeResourceShareLinks(
  db: TenantDb, fga: OpenFgaClient, resource: ResourceRef, _tenantId: string, _actorId: string,
): Promise<RevokeShareLinksResult> {
  const rows = await db.sql<ShareLinkRow[]>`
    SELECT id, resource_type, resource_id, capability FROM share_links
    WHERE resource_type = ${resource.type} AND resource_id = ${resource.id} AND revoked_at IS NULL`
  const cleared: ShareLinkRow[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    try {
      await deleteTuples(fga, [{
        user: `share_link:${row.id}`,
        relation: relationForResource(resource.type, row.capability as Capability),
        object: `${resource.type}:${row.resource_id}`,
      }])
      cleared.push(row)
    } catch (err) {
      // "did not exist" = already cleared (idempotent) → treat as cleared; any other FGA error → leave the
      // link active (revoked_at stays NULL), record it so the "private but link alive on FGA" window is
      // detectable and a re-run picks it up. Do NOT abort the other links or the private-ization.
      if (isAlreadyConverged(err)) cleared.push(row)
      else { failed.push(row.id); console.error('[share-link:revoke-fga-failed]', { linkId: row.id, resource, err: String(err) }) }
    }
  }
  // Atomic DB: mark revoked_at for exactly the FGA-cleared links, in one tx (all-or-nothing — no partial
  // DB revocation). `AND revoked_at IS NULL` keeps a re-run idempotent (a concurrent revoke can't double-set).
  if (cleared.length) {
    await db.tx(async (tx) => {
      for (const row of cleared) await tx`UPDATE share_links SET revoked_at = now() WHERE id = ${row.id} AND revoked_at IS NULL`
    })
  }
  // #220 (option A): persist a DURABLE marker for the FGA-delete failures (not just the #109 log above) so
  // the periodic sweep can retry EXACTLY these links — never re-deriving "failed" from private + revoked_at
  // NULL (which can't distinguish a revoke-failure zombie from a legitimate active link on a private page).
  // Best-effort: if the marker write ITSELF fails (DB unreachable), degrade to the log-only #109 behaviour
  // (the link stays revoked_at NULL and is recovered when a later revoke of the same resource retries it).
  if (failed.length) {
    try {
      await db.tx(async (tx) => {
        for (const id of failed) await tx`UPDATE share_links SET revoke_failed_at = now() WHERE id = ${id} AND revoked_at IS NULL`
      })
    } catch (err) {
      console.error('[share-link:revoke-mark-failed]', { failed, err: String(err) })
    }
  }
  return { revoked: cleared.map((r) => ({ id: r.id, pageId: r.resource_id })), failed }
}

// #220 (option A): periodic reconcile of the FGA-delete failures recorded by revokeResourceShareLinks. A page
// or space made private revokes its links; if the FGA delete errored, the link carries revoke_failed_at (a
// durable marker) and is still live on FGA — a "private but link alive" leak window. This sweep retries the
// FGA delete for ONLY those marked links (a legitimate active link has revoke_failed_at NULL and is never
// touched), and on success completes the revoke (revoked_at set, marker cleared). Idempotent: a "did not
// exist" FGA delete counts as cleared; a still-failing delete leaves the marker for the next sweep.
//
// Cross-tenant like the outbox workers, but share_links is FORCE RLS, so it can't be scanned on the app pool
// without a tenant scope. The `tenants` registry has NO RLS (001), so enumerate it and process each tenant
// under its own app.tenant_id (set_config), mirroring drainAuditOutbox's per-tenant loop. Returns the number
// of links healed (FGA cleared + revoke completed).
export async function sweepShareLinkRevokeFailures(fga: OpenFgaClient): Promise<number> {
  const tenants = await pool<{ id: string }[]>`SELECT id FROM tenants`
  let healed = 0
  for (const { id: tenantId } of tenants) {
    try {
      const rows = await withTenantTx(tenantId, async (tx) => {
        return tx<Pick<ShareLinkRow, 'id' | 'resource_type' | 'resource_id' | 'capability'>[]>`
          SELECT id, resource_type, resource_id, capability FROM share_links
          WHERE revoke_failed_at IS NOT NULL AND revoked_at IS NULL`
      })
      for (const row of rows) {
        const resource: ResourceRef = { type: row.resource_type as ResourceRef['type'], id: row.resource_id }
        try {
          await deleteTuples(fga, [{
            user: `share_link:${row.id}`,
            relation: relationForResource(resource.type, row.capability as Capability),
            object: `${resource.type}:${row.resource_id}`,
          }])
        } catch (err) {
          // "did not exist" = already gone → complete the revoke below; any other error → still failing,
          // leave the marker and retry on the next sweep.
          if (!isAlreadyConverged(err)) continue
        }
        // FGA tuple is gone (deleted now, or already absent): finish the revoke durably and clear the marker.
        await withTenantTx(tenantId, async (tx) => {
          await tx`UPDATE share_links SET revoked_at = now(), revoke_failed_at = NULL WHERE id = ${row.id} AND revoked_at IS NULL`
        })
        healed++
      }
    } catch {
      // Leave this tenant's marked rows for the next sweep (FGA still down, or a transient DB error).
    }
  }
  return healed
}

// Start the periodic share-link revoke-failure sweep (call from the server entry, NOT buildApp — tests drive
// sweepShareLinkRevokeFailures directly, so no stray timer leaks into app.inject). Failures are rare, so the
// default interval is coarse. The in-process `running` guard prevents overlap within one instance; the
// per-row `revoked_at IS NULL` guard keeps it idempotent across instances.
export function startShareLinkSweepWorker(fga: OpenFgaClient, intervalMs = 60000): () => void {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      // #637 / ADR-216 §2: not on behalf of a request, and it SAYS so. An explicit unrestricted scope,
      // rather than arriving with none — which in a process that declared the requirement is a crash, and
      // in one that has not is indistinguishable from a request path where somebody forgot.
      await runInAuthzScope(SYSTEM_SCOPE, () => sweepShareLinkRevokeFailures(fga))
    } catch {
      /* next tick retries */
    } finally {
      running = false
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export interface MintedGuestToken {
  token: string
  docName: string
  capability: Capability
  readOnly: boolean
}

// Public landing: mint a short-lived guest token for a link id. No auth — the
// link id is the capability. Tenant comes from the request Host (RLS stays on;
// no bypass). Every DEAD failure mode returns the same null so the caller can answer 404
// uniformly and leak nothing about a link's existence/state to an enumerator.
// #233 / ADR-107: mint is now 3-way. `null` = a DEAD link (unknown / revoked / expired / FGA-denied) —
// a UNIFORM 404 that never reveals whether the link exists OR whether it has a password. `'password_required'`
// = a LIVE link that needs a password and none/a wrong one was given (wrong ≡ missing — no oracle). A token
// = success. The password branch runs ONLY after every dead-state check, so a dead link can never surface
// `password_required` (existence-hiding).
export type MintResult = MintedGuestToken | null | 'password_required'

export async function mintTokenForShareLink(
  fga: OpenFgaClient,
  tenantId: string,
  id: string,
  password?: string | null,
): Promise<MintResult> {
  // Fast first-pass under RLS (NOT the security gate): cheaply reject obviously
  // dead links before touching FGA.
  const row = (await withTenantTx(tenantId, async (tx) => {
    const [r] = await tx<ShareLinkRow[]>`
      SELECT id, tenant_id, resource_type, resource_id, capability, expires_at, created_by, created_at, revoked_at, password_hash
      FROM share_links WHERE id = ${id}
    `
    return r ?? null
  })) as ShareLinkRow | null

  if (!row) return null
  if (row.revoked_at) return null
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) return null

  const resource: ResourceRef = { type: row.resource_type as ResourceRef['type'], id: row.resource_id }
  const capability = row.capability as Capability

  // AUTHORITATIVE gate: the FGA grant must still be live (and, for time-bounded
  // links, the non_expired condition must pass at current_time). This is what
  // makes revocation correct even if the DB row and FGA tuple diverge — e.g. the
  // tuple was deleted but the revoked_at UPDATE failed: FGA says no -> no token.
  // check() maps the capability to the per-type FGA relation (space view → 'viewer'), so we
  // pass the capability. The minted token carries the resource so the collab join point
  // authorizes the right pages (a space token → any published page in the space).
  const allowed = await check(fga, `share_link:${row.id}`, capability, resource, {
    current_time: new Date().toISOString(),
  })
  if (!allowed) return null

  // #233 / ADR-107: password gate — LAST, after every dead-state + the authoritative FGA check, so a dead
  // link never reaches here (existence-hiding: dead → 404, live+password → 401). Wrong ≡ missing (both
  // fail the verify → the same 'password_required'), so there is no wrong-vs-missing oracle.
  if (row.password_hash) {
    if (!password || !(await verifySharePassword(password, row.password_hash))) return 'password_required'
  }

  // Token TTL is the SHORT of the configured guest TTL and the link's remaining
  // life. Short TTL is what bounds how long an already-connected guest keeps
  // access after revocation (the project design notes: connected guests hold the JWT until exp).
  let ttl = guestCfg.ttlSeconds
  if (row.expires_at) {
    const remaining = Math.floor((row.expires_at.getTime() - Date.now()) / 1000)
    ttl = Math.max(1, Math.min(ttl, remaining))
  }

  const token = await mintGuestToken(
    { secret: guestCfg.secret, ttlSeconds: ttl },
    { tenantId, shareLinkId: row.id, resource, capability },
  )
  // A page link points at one collab doc; a space link has no single doc — the client uses
  // the space marker to show the space's pages and connects per-page (t:<tenant>:p:<pageId>).
  const docName = resource.type === 'space' ? `t:${tenantId}:s:${resource.id}` : `t:${tenantId}:p:${resource.id}`
  return { token, docName, capability, readOnly: capability === 'view' }
}

// ── Fastify plugin ─────────────────────────────────────────────────────────

export async function shareLinksPlugin(app: FastifyInstance) {
  app.post<{ Body: { resource: ResourceRef; capability: Capability; expiresInSeconds?: number | null; password?: string | null } }>(
    '/share-links',
    async (req, reply) => {
      const link = await createShareLink(req.db, app.fga, {
        tenantId: req.tenant.id,
        plan: req.tenant.plan,
        userId: req.user.sub,
        resource: req.body.resource,
        capability: req.body.capability,
        expiresInSeconds: req.body.expiresInSeconds ?? null,
        password: req.body.password ?? null, // #233: optional password (set at issuance only)
      })
      return reply.code(201).send(link)
    },
  )

  // #623: both list routes are paged. `paging()` is shared so the two cannot drift — they read the
  // same query and must offer the same controls.
  const paging = (q: { limit?: string; cursor?: string }) => {
    const limit = Number.parseInt(q.limit ?? '', 10)
    return { ...(Number.isFinite(limit) ? { limit } : {}), ...(q.cursor ? { cursor: q.cursor } : {}) }
  }

  app.get<{ Params: { pageId: string }; Querystring: { limit?: string; cursor?: string } }>('/pages/:pageId/share-links', async (req) => {
    return listShareLinks(req.db, app.fga, { resource: { type: 'page', id: req.params.pageId }, userId: req.user.sub, ...paging(req.query) })
  })

  app.get<{ Params: { spaceId: string }; Querystring: { limit?: string; cursor?: string } }>('/spaces/:spaceId/share-links', async (req) => {
    return listShareLinks(req.db, app.fga, { resource: { type: 'space', id: req.params.spaceId }, userId: req.user.sub, ...paging(req.query) })
  })

  app.delete<{ Params: { id: string } }>('/share-links/:id', async (req, reply) => {
    await revokeShareLink(req.db, app.fga, { id: req.params.id, userId: req.user.sub, tenantId: req.tenant.id })
    return reply.code(204).send()
  })

  // PUBLIC, unauthenticated (under /public/, skipped by the auth onRequest hook). Rate-limited
  // (#107 / ADR-026): two INDEPENDENT fixed-window buckets in Valkey — per client IP and per
  // link id — checked in a preHandler BEFORE the lookup, so a 429 is emitted for a valid OR an
  // unknown id alike (outcome-agnostic: the limiter never becomes an existence oracle; 404 stays
  // the only existence signal). Valkey is the shared store so the limit holds across replicas
  // (prod runs >1). NB: implemented directly on the existing ioredis (app.valkey) rather than
  // pulling in @fastify/rate-limit (ADR-026's suggestion) — the confirmed mechanism is two
  // ORDERED buckets, which the plugin can't express cleanly, and this adds no new dependency.
  app.post<{ Params: { id: string }; Body: { password?: string } }>(
    '/public/share-links/:id/token',
    {
      preHandler: async (req, reply) => {
        const ip = req.ip
        const id = req.params.id
        // #233: BEFORE bumping the general buckets, check the DEDICATED wrong-password buckets (which are
        // bumped in the handler on a wrong/missing password) so a brute-forcer is stopped by the narrow
        // limit first. These NEVER become an existence oracle: they only ever hold counts for links that
        // reached the password branch (which is past every dead-state check), so their 429 reveals nothing
        // a 401 didn't already. per (link, IP) 5/min AND per link 30/hour (ADR-107 comment 967).
        const pwIpOk = await peekRateBucket(app.valkey, `rl:slxpw:ip:${id}:${ip}`, PW_RL_IP_MAX)
        const pwLinkOk = await peekRateBucket(app.valkey, `rl:slxpw:link:${id}`, PW_RL_LINK_MAX)
        if (!pwIpOk || !pwLinkOk) {
          const ttl = await app.valkey.ttl(pwIpOk ? `rl:slxpw:link:${id}` : `rl:slxpw:ip:${id}:${ip}`)
          reply.header('Retry-After', String(Math.max(1, ttl)))
          return reply.code(429).send({ error: 'too many requests' })
        }
        // Bump BOTH general buckets regardless of outcome (the per-link bucket must not depend on the
        // lookup succeeding — no success/existence oracle). 429 if EITHER is over its window.
        const okIp = await bumpRateBucket(app.valkey, `rl:slx:ip:${ip}`, EXCHANGE_RL_IP_MAX)
        const okLink = await bumpRateBucket(app.valkey, `rl:slx:link:${id}`, EXCHANGE_RL_LINK_MAX)
        if (!okIp || !okLink) {
          const ttl = await app.valkey.ttl(okIp ? `rl:slx:link:${id}` : `rl:slx:ip:${ip}`)
          reply.header('Retry-After', String(Math.max(1, ttl)))
          return reply.code(429).send({ error: 'too many requests' })
        }
      },
    },
    async (req, reply) => {
      const { slug, domain } = resolveTenantFromHost(req.headers.host ?? '')
      const tenant = await loadTenant(slug, domain)
      // Uniform 404 for unknown tenant too — never reveal anything to an enumerator.
      if (!tenant) return reply.code(404).send({ error: 'not found' })

      const minted = await mintTokenForShareLink(app.fga, tenant.id, req.params.id, req.body?.password)
      // #715 / ADR-229: the funnel's DENOMINATOR — a visitor got in through a link. Only a minted
      // token counts: a dead, revoked or password-refused link never reached the product, so it is
      // not a visit. The call carries no argument, so nothing about this visitor can be recorded.
      if (minted && minted !== 'password_required') reportLinkVisit()
      if (minted === 'password_required') {
        // #233: a live password link. Bump the DEDICATED wrong-password buckets ONLY when a password
        // was actually SUBMITTED and rejected — NOT on the prompt-display path where no password is
        // sent. ShareRoute first POSTs with no password to discover the link needs one (React
        // StrictMode even double-fires that), so counting the empty-password 401 would exhaust the
        // 5/min bucket on the very first load and lock the user out after a single typo (review
        // #233). The 401 response is identical either way, so wrong≡missing is preserved — the
        // throttle only reflects information the requester already has (whether they submitted a
        // password), so it is not a new existence oracle. A correct password never reaches here; a
        // dead link returns 404 above. per (link, IP) 5/min + per link 30/hour, fixed-window.
        const submittedPassword = typeof req.body?.password === 'string' && req.body.password.length > 0
        if (submittedPassword) {
          const ip = req.ip
          await bumpDurationBucket(app.valkey, `rl:slxpw:ip:${req.params.id}:${ip}`, PW_RL_WINDOW_S)
          await bumpDurationBucket(app.valkey, `rl:slxpw:link:${req.params.id}`, PW_RL_HOUR_S)
        }
        return reply.code(401).send({ error: 'password_required' })
      }
      if (!minted) return reply.code(404).send({ error: 'not found' })
      return reply.send(minted)
    },
  )
}

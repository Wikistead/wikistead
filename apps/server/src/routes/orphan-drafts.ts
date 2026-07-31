import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { emit } from '@wikistead/events'
import { writeTuples, deleteTuples, readObjectTuples, requireTenantAdminOr404 } from '@wikistead/authz'
import type { TenantDb } from '../db/index.js'
import { auditIfEntitled } from '../audit/outbox.js'

// Default claim TTL: an un-reassigned claim auto-expires back to orphan after this (ADR-061).
// A conservative ops default (24h); tunable. Enforced by the reconciling sweep (no time-
// conditioned tuple, since the FGA model has no user-scoped non_expired — see migration 031).
export const CLAIM_TTL_SECONDS = 24 * 60 * 60

// Admin handoff for orphaned strict-private drafts (#99 / ADR-061). authz-critical.
//
// An unpublished page is strict-private: only its creator's FGA grant reaches it (no
// page#space inheritance until publish — the Phase 4 gate). When that member is deleted,
// their `user:<sub>` tuples are removed and the draft becomes UNREACHABLE — a tenant admin
// deliberately can't see it either (strict-private does not inherit tenant-admin).
//
// This module ships the READ side of the handoff: enumerate the orphans so an admin can
// SEE which drafts are stranded. The recovery WRITES (claim → reassign, with a server-side
// TOCTOU re-check and a TTL) are a separate, audited step (ADR-061 sub-tasks 2–3).
//
// Existence hiding (ADR-061): a non-admin gets 404 — not 403 — on every endpoint, so the
// very existence of the recovery capability is not disclosed.

// 404 (not 403) for non-admins: hide the capability's existence entirely (ADR-061).
// The gate is the shared one-tenant-admin helper (#383); re-exported for the authz-boundary test
// (the 404 path is security-critical) so the existing test import keeps resolving here.
export { requireTenantAdminOr404 }

export interface OrphanDraft { id: string; title: string; createdAt: Date }

// Live tenant-member subjects (`user:<sub>`) — the set a grant must reach for a page to count
// as "reachable" (not orphan). RLS scopes the query to the current tenant.
async function liveMemberSubs(db: TenantDb): Promise<Set<string>> {
  const members = await db.sql<{ sub: string }[]>`SELECT sub FROM members`
  return new Set(members.map((m) => `user:${m.sub}`))
}

// Does any FGA grant on this page reach LIVE access? space inheritance / public / a group /
// a live member's direct grant all count as reachable. A grant pointing only at a non-member
// (a deleted creator) does NOT. Errs toward "reachable" (a group counts) so a shared page is
// never falsely orphaned. This is the single source of the orphan reachability rule.
async function pageHasLiveAccess(fga: OpenFgaClient, pageId: string, liveSubs: Set<string>): Promise<boolean> {
  // #553 re-review: paginated — a truncated read can miss the ONE grant that makes a page reachable
  // and mark a live page an orphan (this list drives an admin recovery flow).
  const tuples = await readObjectTuples(fga, `page:${pageId}`)
  return tuples.some((t) => {
    const u = t.user ?? ''
    if (u.startsWith('space:')) return true        // inherits from a space (published/shared)
    if (u === 'user:*') return true                // public
    if (u.includes('#')) return true               // group#member — treat as potentially live
    if (u.startsWith('user:')) return liveSubs.has(u) // a live member holds a direct grant
    return false
  })
}

// Enumerate orphaned drafts (ADR-061): UNPUBLISHED pages (published_at IS NULL → no space
// inheritance, creator-only) that have NO live access — every FGA grant on the page points at
// a user who is no longer a tenant member, or there are no grants at all (the creator's tuple
// was deleted with the member). BOTH conditions are required: a live creator, a live viewer, a
// public/space/group grant all EXCLUDE the page (a live strict-private draft is never listed —
// the strict-private guarantee for live creators holds).
//
// Detection errs toward NOT listing: a space/public/group grant is treated as reachable so a
// shared or published-into-a-space page never falsely shows as orphan (no false recovery target).
export async function listOrphanDrafts(
  db: TenantDb,
  fga: OpenFgaClient,
  _args: { tenantId: string },
): Promise<OrphanDraft[]> {
  // Candidate drafts: never published. RLS scopes the query to the current tenant. A TRASHED draft is
  // excluded (#411 / ADR-153): its recovery surface is the trash (restore), not the orphan-drafts claim —
  // listing it here would leak its title past the trash's per-root manage gate.
  const candidates = await db.sql<{ id: string; title: string; created_at: Date }[]>`
    SELECT id, title, created_at FROM pages WHERE published_at IS NULL AND deleted_at IS NULL ORDER BY created_at
  `
  if (candidates.length === 0) return []
  const liveSubs = await liveMemberSubs(db)
  const orphans: OrphanDraft[] = []
  for (const c of candidates) {
    if (!(await pageHasLiveAccess(fga, c.id, liveSubs))) {
      orphans.push({ id: c.id, title: c.title, createdAt: c.created_at })
    }
  }
  return orphans
}

// Is this ONE page currently an orphan? UNPUBLISHED (published_at IS NULL) AND no live access.
// This is the server-side TOCTOU re-evaluation claim runs (never trusts the client): a live
// strict-private page (published, or with any live grant) returns false → claim is refused.
export async function isOrphanPage(db: TenantDb, fga: OpenFgaClient, pageId: string): Promise<boolean> {
  const [row] = await db.sql<{ published_at: Date | null; deleted_at: Date | null }[]>`
    SELECT published_at, deleted_at FROM pages WHERE id = ${pageId}
  `
  // Unknown, published, or trashed (#411 — the trash owns its recovery; a claim here would mint a manage
  // grant that sidesteps the trash's per-root gate) → not claimable as an orphan.
  if (!row || row.published_at != null || row.deleted_at != null) return false
  const liveSubs = await liveMemberSubs(db)
  return !(await pageHasLiveAccess(fga, pageId, liveSubs))
}

// Claim an orphaned draft: grant the calling admin a TEMPORARY `manage` grant so they can read
// the content to pick a new owner. authz-critical (ADR-061):
//   - re-evaluates the orphan condition server-side (TOCTOU) — a non-orphan pageId is rejected
//     with 404 (no existence leak; a live strict-private page can NEVER be peeked via claim);
//   - the claim row's PK (tenant_id, page_id) enforces one claim at a time (concurrent → 409);
//   - records expiry so the sweep can revoke an un-reassigned claim (page returns to orphan).
export async function claimOrphanDraft(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; pageId: string; adminSub: string; plan?: string; ttlSeconds?: number },
): Promise<{ pageId: string; expiresAt: string }> {
  // TOCTOU: re-check it is actually an orphan right now. 404 (not 403) — never reveal that a
  // non-orphan (live strict-private) page exists, and make claim unusable as a peek primitive.
  if (!(await isOrphanPage(db, fga, args.pageId))) {
    throw Object.assign(new Error('not found'), { statusCode: 404 })
  }
  const ttl = args.ttlSeconds ?? CLAIM_TTL_SECONDS
  // Row + durable audit in ONE tx (ADR-061: audit failure = operation failure); FGA grant LAST so
  // a grant failure rolls back the row + audit (ADR-003). PK guards a concurrent claim.
  const expiresAt = await db.tx(async (tx) => {
    const [claim] = await tx<{ expires_at: Date }[]>`
      INSERT INTO orphan_claims (tenant_id, page_id, admin_sub, expires_at)
      VALUES (${args.tenantId}, ${args.pageId}, ${args.adminSub}, now() + make_interval(secs => ${ttl}))
      ON CONFLICT (tenant_id, page_id) DO NOTHING
      RETURNING expires_at
    `
    if (!claim) throw Object.assign(new Error('already claimed'), { statusCode: 409, code: 'already_claimed' })
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.adminSub}`, action: 'orphan_draft.claimed', target: `page:${args.pageId}` })
    }
    await writeTuples(fga, [{ user: `user:${args.adminSub}`, relation: 'manage_direct', object: `page:${args.pageId}` }])
    return claim.expires_at.toISOString()
  })
  emit({ type: 'orphan_draft.claimed', tenantId: args.tenantId, actorId: args.adminSub, pageId: args.pageId, expiresAt })
  return { pageId: args.pageId, expiresAt }
}

// Reassign a claimed orphan to a live tenant member, and REVOKE the admin's temporary grant
// (ADR-061): the admin never keeps permanent access. Requires an active claim by this admin;
// the new owner must be a live member (tenant isolation).
export async function reassignOrphanDraft(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; pageId: string; adminSub: string; newOwnerSub: string; plan?: string },
): Promise<void> {
  await db.tx(async (tx) => {
    const [claim] = await tx<{ page_id: string }[]>`
      SELECT page_id FROM orphan_claims WHERE page_id = ${args.pageId} AND admin_sub = ${args.adminSub}
    `
    if (!claim) throw Object.assign(new Error('not found'), { statusCode: 404 }) // must claim first
    const [member] = await tx<{ sub: string }[]>`SELECT sub FROM members WHERE sub = ${args.newOwnerSub}`
    if (!member) throw Object.assign(new Error('new owner must be a tenant member'), { statusCode: 400, code: 'not_a_member' })

    // DB first (delete claim + audit), FGA last — a grant failure rolls back the claim delete +
    // audit (ADR-003 ordering + ADR-061 audit-failure = operation-failure).
    await tx`DELETE FROM orphan_claims WHERE tenant_id = ${args.tenantId} AND page_id = ${args.pageId}`
    if (args.plan !== undefined) {
      await auditIfEntitled(tx, { id: args.tenantId, plan: args.plan }, { actor: `user:${args.adminSub}`, action: 'orphan_draft.reassigned', target: `page:${args.pageId}` })
    }
    await writeTuples(fga, [{ user: `user:${args.newOwnerSub}`, relation: 'manage_direct', object: `page:${args.pageId}` }])
    await deleteTuples(fga, [{ user: `user:${args.adminSub}`, relation: 'manage_direct', object: `page:${args.pageId}` }])
  })
  emit({ type: 'orphan_draft.reassigned', tenantId: args.tenantId, actorId: args.adminSub, pageId: args.pageId, newOwner: `user:${args.newOwnerSub}` })
}

export async function orphanDraftsPlugin(app: FastifyInstance) {
  // On-demand only (ADR-061: no proactive surfacing). tenant#admin gated; 404 for non-admins.
  app.get('/admin/orphan-drafts', async (req) => {
    await requireTenantAdminOr404(app.fga, req.user.sub, req.tenant.id)
    const orphans = await listOrphanDrafts(req.db, app.fga, { tenantId: req.tenant.id })
    emit({ type: 'orphan_draft.enumerated', tenantId: req.tenant.id, actorId: req.user.sub, count: orphans.length })
    return orphans
  })

  // Claim → temporary audited admin access (server re-checks the orphan condition; TOCTOU).
  app.post<{ Params: { pageId: string } }>('/admin/orphan-drafts/:pageId/claim', async (req, reply) => {
    await requireTenantAdminOr404(app.fga, req.user.sub, req.tenant.id)
    const r = await claimOrphanDraft(req.db, app.fga, { tenantId: req.tenant.id, pageId: req.params.pageId, adminSub: req.user.sub, plan: req.tenant.plan })
    return reply.code(201).send(r)
  })

  // Reassign to a live member + revoke the admin's temporary grant.
  app.post<{ Params: { pageId: string }; Body: { to?: string } }>('/admin/orphan-drafts/:pageId/reassign', async (req, reply) => {
    await requireTenantAdminOr404(app.fga, req.user.sub, req.tenant.id)
    if (!req.body?.to) return reply.code(400).send({ error: 'to (new owner sub) is required' })
    await reassignOrphanDraft(req.db, app.fga, { tenantId: req.tenant.id, pageId: req.params.pageId, adminSub: req.user.sub, newOwnerSub: req.body.to, plan: req.tenant.plan })
    return reply.code(204).send()
  })
}

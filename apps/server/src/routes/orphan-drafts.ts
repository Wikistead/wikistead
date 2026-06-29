import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { emit } from '@wikistead/events'
import type { TenantDb } from '../db/index.js'

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
// Exported for the authz-boundary test (the 404 path is security-critical).
export async function requireTenantAdminOr404(fga: OpenFgaClient, userId: string, tenantId: string): Promise<void> {
  const { allowed } = await fga.check({ user: `user:${userId}`, relation: 'admin', object: `tenant:${tenantId}` })
  if (!allowed) throw Object.assign(new Error('not found'), { statusCode: 404 })
}

export interface OrphanDraft { id: string; title: string; createdAt: Date }

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
  // Candidate drafts: never published. RLS scopes the query to the current tenant.
  const candidates = await db.sql<{ id: string; title: string; created_at: Date }[]>`
    SELECT id, title, created_at FROM pages WHERE published_at IS NULL ORDER BY created_at
  `
  if (candidates.length === 0) return []
  // Live member subjects (to decide whether any direct grant still reaches a live member).
  const members = await db.sql<{ sub: string }[]>`SELECT sub FROM members`
  const liveSubs = new Set(members.map((m) => `user:${m.sub}`))

  const orphans: OrphanDraft[] = []
  for (const c of candidates) {
    const { tuples } = await fga.read({ object: `page:${c.id}` })
    const reachable = (tuples ?? []).some((t) => {
      const u = t.key?.user ?? ''
      if (u.startsWith('space:')) return true        // inherits from a space (published/shared)
      if (u === 'user:*') return true                // public
      if (u.includes('#')) return true               // group#member — treat as potentially live
      if (u.startsWith('user:')) return liveSubs.has(u) // a live member holds a direct grant
      return false
    })
    if (!reachable) orphans.push({ id: c.id, title: c.title, createdAt: c.created_at })
  }
  return orphans
}

export async function orphanDraftsPlugin(app: FastifyInstance) {
  // On-demand only (ADR-061: no proactive surfacing). tenant#admin gated; 404 for non-admins.
  app.get('/admin/orphan-drafts', async (req) => {
    await requireTenantAdminOr404(app.fga, req.user.sub, req.tenant.id)
    const orphans = await listOrphanDrafts(req.db, app.fga, { tenantId: req.tenant.id })
    emit({ type: 'orphan_draft.enumerated', tenantId: req.tenant.id, actorId: req.user.sub, count: orphans.length })
    return orphans
  })
}

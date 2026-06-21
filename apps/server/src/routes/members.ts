// Member management + invites (P1.4) — the Admin Console's core API. EVERY route
// here is admin-only (requireTenantAdmin): a non-admin member must not see the
// member list, issue/revoke invites, change roles, or remove anyone. Authorization
// is OpenFGA (tenant#admin), re-checked per request, so a demotion takes effect
// immediately (the cached session role is cosmetic).
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { writeTuples, deleteTuples } from '@wikistead/authz'
import { createInvite, revokeInvite, type InviteRole } from '../auth/invites.js'
import { destroyMemberSessions } from '../auth/session.js'
import { emit } from '@wikistead/events'

const ROLES: InviteRole[] = ['admin', 'member']

// Admin gate. tenant#admin is the authority (raw relation, not a Capability).
async function requireTenantAdmin(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const { allowed } = await req.server.fga.check({
    user: `user:${req.user.sub}`,
    relation: 'admin',
    object: `tenant:${req.tenant.id}`,
  })
  if (!allowed) {
    await reply.code(403).send({ error: 'admin only' })
    return false
  }
  return true
}

async function adminCount(req: FastifyRequest): Promise<number> {
  const [{ n }] = await req.db.sql<[{ n: number }]>`
    SELECT count(*)::int AS n FROM members WHERE role = 'admin'`
  return n
}

export async function membersPlugin(app: FastifyInstance) {
  // ── Members ────────────────────────────────────────────────────────────────
  app.get('/members', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const rows = await req.db.sql<
      { sub: string; email: string | null; display_name: string | null; role: string; created_at: Date }[]
    >`SELECT sub, email, display_name, role, created_at FROM members ORDER BY created_at`
    return { members: rows }
  })

  // Change a member's role (admin ↔ member). ADR-003: DB first, FGA last, inside one
  // tx → a FGA failure rolls the role change back. Cannot demote the last admin
  // (that would lock the tenant out of its own administration).
  app.patch<{ Params: { sub: string }; Body: { role?: string } }>('/members/:sub', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const role = req.body?.role
    if (role !== 'admin' && role !== 'member') return reply.code(400).send({ error: 'invalid role' })

    const [existing] = await req.db.sql<[{ role: string }?]>`
      SELECT role FROM members WHERE sub = ${req.params.sub}`
    if (!existing) return reply.code(404).send({ error: 'member not found' })
    if (existing.role === role) return { ok: true } // no-op

    if (existing.role === 'admin' && role === 'member' && (await adminCount(req)) <= 1) {
      return reply.code(409).send({ error: 'cannot demote the last admin' })
    }

    await req.db.tx(async (tx) => {
      await tx`UPDATE members SET role = ${role}, updated_at = now() WHERE sub = ${req.params.sub}`
      const adminTuple = [{ user: `user:${req.params.sub}`, relation: 'admin', object: `tenant:${req.tenant.id}` }]
      if (role === 'admin') await writeTuples(req.server.fga, adminTuple)
      else await deleteTuples(req.server.fga, adminTuple)
    })
    emit({ type: 'member.role_changed', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.params.sub, role })
    return { ok: true }
  })

  // Remove a member. ADR-003 ordering; then revoke ALL their live sessions so the
  // removal is immediate (not at TTL). Cannot remove the last admin.
  app.delete<{ Params: { sub: string } }>('/members/:sub', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const [existing] = await req.db.sql<[{ role: string }?]>`
      SELECT role FROM members WHERE sub = ${req.params.sub}`
    if (!existing) return reply.code(404).send({ error: 'member not found' })
    if (existing.role === 'admin' && (await adminCount(req)) <= 1) {
      return reply.code(409).send({ error: 'cannot remove the last admin' })
    }

    await req.db.tx(async (tx) => {
      await tx`DELETE FROM members WHERE sub = ${req.params.sub}`
      // Remove the membership grants. Only delete the admin tuple if it exists —
      // FGA rejects the whole batch if asked to delete a non-existent tuple.
      const tuples = [{ user: `user:${req.params.sub}`, relation: 'member', object: `tenant:${req.tenant.id}` }]
      if (existing.role === 'admin') tuples.push({ user: `user:${req.params.sub}`, relation: 'admin', object: `tenant:${req.tenant.id}` })
      await deleteTuples(req.server.fga, tuples) // FGA last → rollback on failure
    })
    await destroyMemberSessions(req.server.valkey, req.tenant.id, req.params.sub)
    emit({ type: 'member.removed', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.params.sub })
    return reply.code(204).send()
  })

  // ── Invites ──────────────────────────────────────────────────────────────
  app.get('/members/invites', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const rows = await req.db.sql<
      { id: string; email: string | null; role: string; invited_by: string; expires_at: Date; created_at: Date }[]
    >`SELECT id, email, role, invited_by, expires_at, created_at
        FROM invites WHERE status = 'pending' AND expires_at > now() ORDER BY created_at DESC`
    return { invites: rows }
  })

  // Create an invite. Seat cap is enforced in createInvite (UNLIMITED self-host
  // skips it). Email is BEST-EFFORT (P1.3) — the invite link is authoritative, so
  // we always return it; `emailed` reports whether delivery was attempted+ok.
  app.post<{ Body: { email?: string; role?: string } }>('/members/invites', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const role = (req.body?.role ?? 'member') as InviteRole
    if (!ROLES.includes(role)) return reply.code(400).send({ error: 'invalid role' })
    const email = req.body?.email?.trim() || null

    let token: string
    try {
      ;({ token } = await createInvite(req.db, { tenantId: req.tenant.id, plan: req.tenant.plan, invitedBy: req.user.sub, email, role }))
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode ?? 500
      return reply.code(code).send({ error: code === 403 ? 'seat limit reached' : 'could not create invite' })
    }

    const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http'
    const inviteUrl = `${scheme}://${req.headers.host}/invite?token=${token}`

    let emailed = false
    if (email) {
      try {
        await req.server.email.send({
          to: email,
          subject: `You're invited to ${req.tenant.slug} on wikistead`,
          text: `You've been invited to join ${req.tenant.slug}. Open this link to accept:\n\n${inviteUrl}`,
          html: `<p>You've been invited to join <strong>${req.tenant.slug}</strong> on wikistead.</p><p><a href="${inviteUrl}">Accept your invitation</a></p>`,
        })
        emailed = true
      } catch (err) {
        req.log.warn({ err }, 'invite email send failed — link still valid')
      }
    }
    emit({ type: 'invite.created', tenantId: req.tenant.id, actorId: req.user.sub, role })
    return reply.code(201).send({ inviteUrl, emailed })
  })

  app.delete<{ Params: { id: string } }>('/members/invites/:id', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const ok = await revokeInvite(req.db, req.params.id)
    if (!ok) return reply.code(404).send({ error: 'invite not found or not pending' })
    emit({ type: 'invite.revoked', tenantId: req.tenant.id, actorId: req.user.sub })
    return reply.code(204).send()
  })
}

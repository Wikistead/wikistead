import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { resolveEntitlements } from '@wikistead/entitlements'
import { getAIProvider } from '@wikistead/hooks'
import { emit } from '@wikistead/events'
import { fgaClient } from '@wikistead/authz'
import type { TenantDb } from '../db/index.js'
import { bumpRateBucket } from '../rate-limit.js'
import { gatherAuthorizedContext } from '../ai/context.js'

// Per-tenant AI request cap — a runaway-bill FLOOR (ADR-077 forbids unbounded cost). This is
// a coarse rate limit, NOT the full metered allowance + soft-cap + alerts (that is #128, which
// needs a usage ledger; tracked separately). Generous defaults; env-overridable.
const AI_RATE_LIMIT_PER_TENANT = Number(process.env.AI_RATE_LIMIT_PER_TENANT ?? 60)
const AI_RATE_LIMIT_WINDOW_S = Number(process.env.AI_RATE_LIMIT_WINDOW_S ?? 60)

// AI assist capability + the tenant-level consent toggle (#130 / ADR-077).
//
// ADR-077 two-stage egress consent: AI sends NOTHING to a provider unless BOTH
//   (a) an operator registered an AIProvider (deployment switch — getAIProvider != null), AND
//   (b) the tenant ADMIN enabled AI for THIS tenant (tenant_settings.ai_enabled), AND
//   the plan entitles it (resolveEntitlements(plan).aiFeatures).
// All three are AND-ed; the tenant toggle defaults FALSE (fail-safe — no egress by default).
// `ai_enabled` is read FRESH (req.db, not the 30s tenant cache) so an admin turning it OFF
// stops further egress immediately (consent revocation).

// Read the tenant's AI opt-in (default false when no settings row exists). RLS-scoped via req.db.
export async function getTenantAiEnabled(db: TenantDb): Promise<boolean> {
  const [row] = await db.sql<{ ai_enabled: boolean }[]>`SELECT ai_enabled FROM tenant_settings LIMIT 1`
  return row?.ai_enabled === true
}

// Set the tenant's AI opt-in. Upserts the settings row, preserving other settings columns.
export async function setTenantAiEnabled(db: TenantDb, tenantId: string, enabled: boolean): Promise<void> {
  await db.sql`
    INSERT INTO tenant_settings (tenant_id, ai_enabled)
    VALUES (${tenantId}, ${enabled})
    ON CONFLICT (tenant_id) DO UPDATE SET ai_enabled = ${enabled}, updated_at = now()
  `
}

async function requireTenantAdmin(fga: OpenFgaClient, userId: string, tenantId: string): Promise<void> {
  const { allowed } = await fga.check({ user: `user:${userId}`, relation: 'admin', object: `tenant:${tenantId}` })
  if (!allowed) throw Object.assign(new Error('admin only'), { statusCode: 403 })
}

export async function aiPlugin(app: FastifyInstance) {
  // Member-facing read so the UI can show/hide AI affordances. `available` requires all three
  // consent gates (entitled AND configured AND tenant-enabled) — AI is off by default on every
  // front (Community First). The AI features themselves re-check this server-side.
  app.get('/ai/capability', async (req) => {
    const entitled = resolveEntitlements(req.tenant.plan).aiFeatures
    const configured = getAIProvider() != null
    const tenantEnabled = await getTenantAiEnabled(req.db)
    return { available: entitled && configured && tenantEnabled, entitled, configured, tenantEnabled }
  })

  // Admin: read the tenant AI opt-in.
  app.get('/admin/ai-settings', async (req, reply) => {
    try {
      await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    } catch {
      return reply.code(403).send({ error: 'admin only' })
    }
    return { aiEnabled: await getTenantAiEnabled(req.db) }
  })

  // Admin: toggle the tenant AI opt-in (the tenant half of ADR-077 two-stage consent).
  app.put<{ Body: { enabled?: boolean } }>('/admin/ai-settings', async (req, reply) => {
    try {
      await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    } catch {
      return reply.code(403).send({ error: 'admin only' })
    }
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled (boolean) required' })
    await setTenantAiEnabled(req.db, req.tenant.id, req.body.enabled)
    emit({ type: 'tenant.ai_toggled', tenantId: req.tenant.id, actorId: req.user.sub, enabled: req.body.enabled })
    return { aiEnabled: req.body.enabled }
  })

  // Ask-KB: answer a question over the asking member's FGA-authorized pages. This is the only
  // egress point — it sends context to the provider ONLY after the full ADR-077 consent gate
  // (entitled AND configured AND tenant opted-in) AND gathers context FGA-scoped (a page the
  // member can't view never reaches the provider). Guests never reach here (/ai/ask is not a
  // guest route → the auth hook rejects a guest token). req.user is therefore always a member.
  app.post<{ Body: { question?: string } }>('/ai/ask', async (req, reply) => {
    if (!req.user) return reply.code(403).send({ error: 'forbidden' }) // defensive: never a guest
    if (!resolveEntitlements(req.tenant.plan).aiFeatures) return reply.code(403).send({ error: 'ai not available' })
    const provider = getAIProvider()
    if (!provider) return reply.code(503).send({ error: 'ai not configured' })
    if (!(await getTenantAiEnabled(req.db))) return reply.code(403).send({ error: 'ai not enabled for this tenant' })

    const question = req.body?.question?.trim()
    if (!question) return reply.code(400).send({ error: 'question required' })

    // Runaway-bill floor (per tenant). Over the cap → 429 (no egress for this request).
    const ok = await bumpRateBucket(app.valkey, `ai-rl:tenant:${req.tenant.id}`, AI_RATE_LIMIT_PER_TENANT, AI_RATE_LIMIT_WINDOW_S)
    if (!ok) {
      reply.header('Retry-After', String(AI_RATE_LIMIT_WINDOW_S))
      return reply.code(429).send({ error: 'ai rate limit exceeded' })
    }

    // FGA-scoped retrieval (the security core): only pages this member can view contribute.
    const { context, sources } = await gatherAuthorizedContext(
      { db: req.db, searchDriver: app.searchDriver, fga: fgaClient },
      { tenantId: req.tenant.id, userSub: req.user.sub, groups: req.user.groups, question },
    )
    const { text } = await provider.complete({ prompt: question, context })
    // TODO(#130/#128): meter token usage here (soft-cap + alerts) once the usage ledger lands.
    return { answer: text, sources }
  })
}

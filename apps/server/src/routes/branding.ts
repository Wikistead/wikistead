import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { resolveEntitlements } from '@wikistead/entitlements'
import { isAccentKey } from '@wikistead/types'
import { emit } from '@wikistead/events'
import type { TenantDb } from '../db/index.js'

// Tenant branding (Phase 5d). Asymmetric by design:
//   READ  GET /branding — PUBLIC (tenant resolved from Host; no auth). Visible to
//         members, guests, and unauthenticated visitors of the tenant's pages.
//         Branding is STRIPPED when the plan isn't entitled (a downgrade reverts to
//         the default look; the stored values survive for a re-upgrade).
//   WRITE PATCH /tenant/branding — tenant#admin AND entitlement-gated (403).
// The tenant logo (upload + public byte delivery) is Phase 5d-2, pending the
// multipart dependency; only accent + display name ship here.
const DISPLAY_NAME_MAX = 64

export interface TenantBranding { displayName: string | null; accentKey: string | null }

// Read the public branding for the (RLS-scoped) tenant, stripped when not entitled.
export async function getTenantBranding(db: TenantDb, plan: string): Promise<TenantBranding> {
  if (!resolveEntitlements(plan).branding) return { displayName: null, accentKey: null }
  const [row] = await db.sql<{ accent_key: string | null; display_name: string | null }[]>`
    SELECT accent_key, display_name FROM tenant_settings LIMIT 1
  `
  return { displayName: row?.display_name ?? null, accentKey: row?.accent_key ?? null }
}

// Set the tenant branding. tenant#admin AND entitlement gated (mirrors members.ts).
export async function updateTenantBranding(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; plan: string; accentKey: string | null; displayName: string | null },
): Promise<void> {
  const { allowed } = await fga.check({ user: `user:${args.userId}`, relation: 'admin', object: `tenant:${args.tenantId}` })
  if (!allowed) throw Object.assign(new Error('admin only'), { statusCode: 403 })
  if (!resolveEntitlements(args.plan).branding) {
    throw Object.assign(new Error('branding requires an upgrade'), { statusCode: 403, code: 'upgrade_required' })
  }
  if (args.accentKey !== null && !isAccentKey(args.accentKey)) {
    throw Object.assign(new Error('unknown accent'), { statusCode: 400 })
  }
  const raw = (args.displayName ?? '').trim()
  const displayName = raw === '' ? null : raw.slice(0, DISPLAY_NAME_MAX)
  await db.sql`
    INSERT INTO tenant_settings (tenant_id, accent_key, display_name, updated_at)
    VALUES (${args.tenantId}, ${args.accentKey}, ${displayName}, now())
    ON CONFLICT (tenant_id) DO UPDATE SET accent_key = ${args.accentKey}, display_name = ${displayName}, updated_at = now()
  `
  emit({ type: 'tenant.branding_updated', tenantId: args.tenantId, actorId: args.userId })
}

export async function brandingPlugin(app: FastifyInstance) {
  // PUBLIC read — the only auth is tenant resolution from the Host (see app.ts).
  app.get('/branding', { config: { public: true } }, async (req) => getTenantBranding(req.db, req.tenant.plan))

  app.patch<{ Body: { accentKey?: string | null; displayName?: string | null } }>('/tenant/branding', async (req, reply) => {
    await updateTenantBranding(req.db, app.fga, {
      tenantId: req.tenant.id, userId: req.user.sub, plan: req.tenant.plan,
      accentKey: req.body?.accentKey ?? null, displayName: req.body?.displayName ?? null,
    })
    return reply.code(204).send()
  })
}

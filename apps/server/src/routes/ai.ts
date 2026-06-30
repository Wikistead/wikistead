import type { FastifyInstance } from 'fastify'
import { resolveEntitlements } from '@wikistead/entitlements'
import { getAIProvider } from '@wikistead/hooks'

// AI assist capability (#130 / ADR-077). Member-facing read so the UI can show/hide AI affordances
// without guessing. `available` requires BOTH the plan lever (aiFeatures) AND a registered provider
// (BYOK deployment switch) — AI is off by default on every front (Community First: no provider = no
// egress/cost). The AI features themselves re-check this and gather FGA-authorized context
// server-side (AI is never an authz side-channel); this endpoint only reports the flags.
export async function aiPlugin(app: FastifyInstance) {
  app.get('/ai/capability', async (req) => {
    const entitled = resolveEntitlements(req.tenant.plan).aiFeatures
    const configured = getAIProvider() != null
    return { available: entitled && configured, entitled, configured }
  })
}

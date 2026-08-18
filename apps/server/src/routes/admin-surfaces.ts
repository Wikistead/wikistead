import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient, ClientBatchCheckSingleResponse } from '@openfga/sdk'
import { fgaModelId } from '@wikistead/authz'
import { auditLedgerRegistered } from '../audit/sink.js' // #688: EE-composed features only surface when composed
import { analyticsRegistered } from '../analytics/sink.js'
import { scimRegistered } from '../scim/sink.js' // #723: SCIM is EE-composed too

// #604 / ADR-208 (ruling B): WHICH admin surfaces may this caller enter?
//
// The carve-out gave somebody `manage_connections` without the admin tier, and the routes honoured
// it — but the console was unreachable: the menu entry was `isAdmin`, so a verb holder never found
// the door. The fix is not a second gate in the client. The client asks the server which surfaces
// are open to it, and renders exactly that.
//
// ONE registry, and it maps a surface to the tenant RELATION that opens it — not to a tier, and not
// to a hand-kept list of "verbs that count". Every carve-out relation unions `or admin`, so an admin
// answers true to all of them without being special-cased here. Adding a verb means adding its
// surface's row: the entry point, the navigation and the direct-link answer all follow from it with
// no second edit — which is why the pin walks THIS table rather than restating it.
export const ADMIN_SURFACES: Readonly<Record<string, string>> = {
  members: 'admin',
  spaces: 'admin',
  branding: 'admin',
  auth: 'manage_connections', // #604-B: sign-in methods — the first power carved out of the tier
  api: 'admin',
  webhooks: 'admin',
  audit: 'view_audit',
  analytics: 'admin',
  roles: 'manage_roles',
  embeds: 'admin',
  public: 'admin',
  moderation: 'admin',
  billing: 'admin',
  orphans: 'admin',
  // #723 / ADR-232: minting the bearer token an IdP needs. Admin-gated like the rest of the
  // credential surfaces; EE-composed, so the filter below hides it in a CE build.
  scim: 'admin',
}

// The surfaces `userId` may enter, in registry order (the console's tab order). One batchCheck over
// the DISTINCT relations — 14 surfaces resolve through 4 checks, and a surface that reuses a
// relation costs nothing.
export async function readableAdminSurfaces(fga: OpenFgaClient, userId: string, tenantId: string): Promise<string[]> {
  const relations = [...new Set(Object.values(ADMIN_SURFACES))]
  const object = `tenant:${tenantId}`
  // #500 / ADR-183: the model id MUST be passed explicitly — the SDK applies it to check() but NOT to
  // server-side batchCheck, and omitting it evaluates against the store's LATEST model while every
  // other gate uses the pinned one. Index correlation ids keep the mapping independent of the payload.
  const { result } = await fga.batchCheck(
    { checks: relations.map((relation, i) => ({ user: `user:${userId}`, relation, object, correlationId: String(i) })) },
    { authorizationModelId: fgaModelId() },
  )
  // Fail CLOSED per item: an errored check means "not open to you" — the routes still gate, so the
  // worst case is a surface hidden from someone who could have entered it, never the reverse.
  const open = new Set(
    result
      .filter((r: ClientBatchCheckSingleResponse) => !r.error && r.allowed)
      .map((r: ClientBatchCheckSingleResponse) => relations[Number(r.correlationId)])
      .filter((relation): relation is string => relation !== undefined),
  )
  // #688: `audit` and `analytics` are EE-composed — a CE build has no routes behind those doors, and
  // the tier alone would render dead navigation there. CE resolves entitlements to UNLIMITED, so the
  // honest signal is REGISTRATION: the mount registered its sink/collector, or the surface is absent.
  const composed = ([k]: [string, string]) =>
    (k !== 'audit' || auditLedgerRegistered()) && (k !== 'analytics' || analyticsRegistered()) &&
    (k !== 'scim' || scimRegistered())
  return Object.entries(ADMIN_SURFACES).filter(composed)
    .filter(([, relation]) => open.has(relation))
    .map(([surface]) => surface)
}

export async function adminSurfacesPlugin(app: FastifyInstance) {
  // Member-authenticated, NOT admin-gated: it answers what YOU may do, which you already know by
  // trying. Gating it on the tier would recreate the very hole this closes (a verb holder could not
  // ask whether their verb opens anything). It names surfaces, never other people's powers.
  app.get('/admin/surfaces', async (req) => ({
    surfaces: await readableAdminSurfaces(app.fga, req.user.sub, req.tenant.id),
  }))
}

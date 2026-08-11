import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
// #604 / ADR-208 (ruling B): this surface is gated on the VERB now, not on the tier. `manage_connections`
// unions `or admin`, so every current admin passes exactly as before; what changes is that a tenant can
// hand out sign-in management alone, which "admin only" could not express.
import { requireConnectionManager } from '@wikistead/authz'
import { emit } from '@wikistead/events'
import { encryptSecret } from '../auth/secret-crypto.js'
import { safeFetchJson } from '../safe-fetch.js'
import { validateIssuer, type DiscoveryFetch } from './tenant-oidc.js'
import { assertNotLastWayIn } from '../auth/login-methods.js'

// #554 S4 / ADR-197 §1-3: the admin management surface for OIDC login connections. tenant#admin
// gated, RLS-scoped. Scope note: SAML keeps its own surface (/admin/saml — one per tenant, EE) and
// the platform connection its one toggle (/admin/login-methods); THIS surface manages the N oidc
// rows. The legacy /admin/oidc surface keeps editing the FIRST connection (byte-compat for the
// existing settings screen) — it and this surface see the same rows.
//
// The rules that live here:
//   - presets (v1: google, microsoft) PREFILL config and brand the button; the Microsoft preset
//     takes the Entra TENANT ID and templates the issuer (common/organizations discovery does not
//     pass openid-client's strict issuer match — ADR review N1). A preset connection REFUSES a
//     label (rev3: no admin-authored string reaches the unauthenticated screen through a branded
//     connection).
//   - a free-text label is allowed ONLY preset-less, with hygiene (S3 handoff): trimmed, ≤64
//     chars, no control/newline/bidi-override characters — it renders on the anonymous screen.
//   - verify-before-enable: enabling requires a passing discovery check, per connection (the same
//     validateIssuer gate the legacy surface has).
//   - the lockout guard goes per-connection: a write that would empty the tenant's EFFECTIVE
//     connection list (disable/delete of the last one) is refused 409 `login_lockout`; a
//     connection that is not currently effective can be edited freely (the guard steps aside).
//   - ADR-197 §5: a NEW connection mints member subs as `wc<conn8>_<externalSub>` — subject_prefix
//     is derived from the connection id at creation and IMMUTABLE (changing it would orphan every
//     member the connection minted). The legacy connection's NULL prefix = raw subs, continuity.
//   - trust_groups is settable HERE (the §2 rev2 "where connections are
//     created" surface) and default FALSE — flipping them is a deliberate admin act.

/**
 * #623 (ruling ③④): how many OIDC connections a tenant may HOLD — a cap, not a page.
 *
 * This list cannot page. Reordering saves the complete ordered id list, so a page would let a tenant
 * hold connections it can neither see nor reorder; and the same rows become sign-in buttons on
 * `/auth/login-options`, where "load more ways to sign in" is not a product. Same family as
 * `MAX_FACTORS_PER_MEMBER` (10) and the pin cap (200): the bound is on what can EXIST.
 *
 * Twenty, by ruling, for both the creatable and the shown count — one number, so a connection that can
 * be created can always be seen. Refused HERE, at issue (#642: never cut the display side while the
 * write keeps minting).
 */
export const MAX_OIDC_CONNECTIONS = 20

const PRESETS: Record<string, { issuer?: (p: { entraTenantId?: string }) => string }> = {
  google: { issuer: () => 'https://accounts.google.com' },
  microsoft: { issuer: (p) => `https://login.microsoftonline.com/${p.entraTenantId}/v2.0` },
}
const ENTRA_TENANT_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

// The label hygiene rule, exported for pins: the string renders on the UNAUTHENTICATED login
// screen, so it is bounded and stripped of the characters that lie (bidi overrides) or break
// layout (control/newline). Empty after trimming = no label.
// #554 S4 review F1: the issuer must be a parseable http(s) URL at WRITE time, enabled or not —
// a stored garbage issuer used to 201 while disabled and then blow up every consumer that parses
// it (the admin list screen crashed whole-page on new URL()).
export function validIssuerShape(issuer: string): boolean {
  try {
    const u = new URL(issuer)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export function sanitizeConnectionLabel(raw: unknown): { ok: true; label: string | null } | { ok: false } {
  if (raw == null || raw === '') return { ok: true, label: null }
  if (typeof raw !== 'string') return { ok: false }
  const label = raw.trim()
  if (label === '') return { ok: true, label: null }
  if (label.length > 64) return { ok: false }
  // control chars, DEL, line/para separators, zero-width family, BOM, and the bidi-override family
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/.test(label)) return { ok: false }
  return { ok: true, label }
}

// ADR-197 §5: wc<conn8>_ — conn8 is the first 8 hex of the minted connection uuid.
export const subjectPrefixFor = (connectionId: string): string => `wc${connectionId.replace(/-/g, '').slice(0, 8)}_`

interface ConnRow {
  id: string; issuer: string; client_id: string; client_secret_enc: string | null; scopes: string
  redirect_uri: string; enabled: boolean; sort: number; label: string | null; preset: string | null
  trust_groups: boolean; subject_prefix: string | null; groups_claim: string | null
  mcp_enabled: boolean
}
const toView = (r: ConnRow) => ({
  id: r.id, kind: 'oidc' as const, issuer: r.issuer, clientId: r.client_id, hasSecret: r.client_secret_enc != null,
  scopes: r.scopes, redirectUri: r.redirect_uri, enabled: r.enabled, sort: r.sort, label: r.label,
  preset: r.preset, trustGroups: r.trust_groups,
  subjectPrefix: r.subject_prefix, groupsClaim: r.groups_claim,
  // #592 / ADR-204: whether this connection's members may reach MCP. `mcpEnforceable` is the honest
  // half: the MCP entry identifies a connection by the `wc<conn8>_` prefix its members' subs carry, so
  // a connection that does not namespace (the pre-#570 legacy row) cannot be told apart there. The UI
  // shows the switch as unavailable rather than letting an admin set a refusal nobody can make.
  mcpEnabled: r.mcp_enabled, mcpEnforceable: r.subject_prefix != null,
})

export async function adminConnectionsPlugin(app: FastifyInstance, opts?: { discoveryFetch?: DiscoveryFetch }) {
  const fetchJson = opts?.discoveryFetch ?? safeFetchJson

  app.get('/admin/connections', async (req) => {
    await requireConnectionManager(app.fga, req.user.sub, req.tenant.id)
    const rows = await req.db.sql<ConnRow[]>`
      SELECT id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, label, preset,
             trust_groups, subject_prefix, groups_claim, mcp_enabled
      FROM tenant_oidc ORDER BY sort, id`
    return rows.map(toView)
  })

  app.post<{ Body: {
    preset?: string; issuer?: string; clientId?: string; clientSecret?: string | null; redirectUri?: string
    scopes?: string; label?: string; entraTenantId?: string; enabled?: boolean
    trustGroups?: boolean; groupsClaim?: string | null
  } }>('/admin/connections', async (req, reply) => {
    await requireConnectionManager(app.fga, req.user.sub, req.tenant.id)
    // #623 ③: the cap is asked FIRST — before any per-field validation — so the answer to "why can't
    // I add one" is the true one rather than whichever field check happens to run first.
    const [{ held }] = await req.db.sql<[{ held: number }]>`
      SELECT COUNT(*)::int AS held FROM tenant_oidc`
    if (held >= MAX_OIDC_CONNECTIONS) {
      throw Object.assign(
        new Error(`this workspace already has ${MAX_OIDC_CONNECTIONS} connections — remove one before adding another`),
        { statusCode: 409, code: 'connection_limit_reached' })
    }
    const b = req.body ?? {}
    const preset = b.preset ?? null
    if (preset !== null && !(preset in PRESETS)) {
      throw Object.assign(new Error('unknown preset'), { statusCode: 400 })
    }
    let issuer = (b.issuer ?? '').trim()
    if (preset === 'google') issuer = PRESETS.google!.issuer!({})
    if (preset === 'microsoft') {
      if (!b.entraTenantId || !ENTRA_TENANT_RE.test(b.entraTenantId)) {
        throw Object.assign(new Error('the Microsoft preset requires the Entra tenant id (a GUID)'), { statusCode: 400 })
      }
      issuer = PRESETS.microsoft!.issuer!({ entraTenantId: b.entraTenantId.toLowerCase() })
    }
    if (preset !== null && b.label != null && b.label !== '') {
      throw Object.assign(new Error('a preset connection wears its own branding — labels are for preset-less connections'), { statusCode: 400 })
    }
    const labelRes = sanitizeConnectionLabel(b.label)
    if (!labelRes.ok) throw Object.assign(new Error('invalid label'), { statusCode: 400 })
    const clientId = (b.clientId ?? '').trim()
    const redirectUri = (b.redirectUri ?? '').trim()
    if (!issuer || !clientId || !redirectUri) {
      throw Object.assign(new Error('issuer, client id and redirect URI are required'), { statusCode: 400 })
    }
    if (!validIssuerShape(issuer)) {
      throw Object.assign(new Error('issuer must be an http(s) URL'), { statusCode: 400 })
    }
    const enabled = b.enabled === true
    if (enabled) {
      const err = await validateIssuer(issuer, fetchJson)
      if (err) throw Object.assign(new Error(err), { statusCode: 400, code: 'oidc_unreachable' })
    }
    // #554 S4 review F5: wc<conn8>_ derives from the uuid's first 8 hex — re-mint on the
    // (astronomically rare, but silently identity-merging) per-tenant prefix collision.
    let id = randomUUID()
    for (let tries = 0; tries < 5; tries++) {
      const [dup] = await req.db.sql<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE subject_prefix = ${subjectPrefixFor(id)} LIMIT 1`
      if (!dup) break
      id = randomUUID()
    }
    const [{ next }] = await req.db.sql<[{ next: number }]>`
      SELECT COALESCE(MAX(sort) + 1, 0)::int AS next FROM tenant_oidc`
    await req.db.sql`
      INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri,
                               enabled, sort, label, preset, trust_groups, subject_prefix, groups_claim)
      VALUES (${id}, ${req.tenant.id}, ${issuer}, ${clientId}, ${b.clientSecret ? encryptSecret(b.clientSecret) : null},
              ${(b.scopes ?? '').trim() || 'openid email profile'}, ${redirectUri}, ${enabled},
              ${next}, ${labelRes.label}, ${preset}, ${b.trustGroups === true},
              ${subjectPrefixFor(id)}, ${b.groupsClaim?.trim() || null})
    `
    emit({ type: 'tenant.oidc_updated', tenantId: req.tenant.id, actorId: req.user.sub, enabled })
    return reply.code(201).send({ id })
  })

  app.patch<{ Params: { id: string }; Body: {
    issuer?: string; clientId?: string; clientSecret?: string | null; redirectUri?: string; scopes?: string
    label?: string | null; enabled?: boolean; trustGroups?: boolean; groupsClaim?: string | null
    mcpEnabled?: boolean
  } }>('/admin/connections/:id', async (req, reply) => {
    await requireConnectionManager(app.fga, req.user.sub, req.tenant.id)
    const [row] = await req.db.sql<ConnRow[]>`
      SELECT id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, label, preset,
             trust_groups, subject_prefix, groups_claim, mcp_enabled
      FROM tenant_oidc WHERE id = ${req.params.id}`
    if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
    const b = req.body ?? {}
    if (row.preset !== null && b.label != null && b.label !== '') {
      throw Object.assign(new Error('a preset connection wears its own branding — labels are for preset-less connections'), { statusCode: 400 })
    }
    const labelRes = b.label !== undefined ? sanitizeConnectionLabel(b.label) : { ok: true as const, label: row.label }
    if (!labelRes.ok) throw Object.assign(new Error('invalid label'), { statusCode: 400 })
    const issuer = (b.issuer ?? row.issuer).trim()
    if (b.issuer !== undefined && !validIssuerShape(issuer)) {
      throw Object.assign(new Error('issuer must be an http(s) URL'), { statusCode: 400 })
    }
    const enabled = b.enabled ?? row.enabled
    if (enabled && (b.enabled === true || b.issuer !== undefined)) {
      const err = await validateIssuer(issuer, fetchJson)
      if (err) throw Object.assign(new Error(err), { statusCode: 400, code: 'oidc_unreachable' })
    }
    if (b.enabled === false && row.enabled) await assertNotLastWayIn(req.db, req.tenant, row.id)
    let secretEnc = row.client_secret_enc
    if (b.clientSecret === null) secretEnc = null
    else if (b.clientSecret) secretEnc = encryptSecret(b.clientSecret)
    await req.db.sql`
      UPDATE tenant_oidc SET
        issuer = ${issuer}, client_id = ${(b.clientId ?? row.client_id).trim()}, client_secret_enc = ${secretEnc},
        scopes = ${(b.scopes ?? row.scopes).trim() || 'openid email profile'}, redirect_uri = ${(b.redirectUri ?? row.redirect_uri).trim()},
        enabled = ${enabled}, label = ${labelRes.label},
        trust_groups = ${b.trustGroups ?? row.trust_groups}, groups_claim = ${b.groupsClaim !== undefined ? (b.groupsClaim?.trim() || null) : row.groups_claim},
        mcp_enabled = ${b.mcpEnabled ?? row.mcp_enabled},
        updated_at = now()
      WHERE id = ${row.id}`
    emit({ type: 'tenant.oidc_updated', tenantId: req.tenant.id, actorId: req.user.sub, enabled })
    return reply.code(204).send()
  })

  app.delete<{ Params: { id: string } }>('/admin/connections/:id', async (req, reply) => {
    await requireConnectionManager(app.fga, req.user.sub, req.tenant.id)
    const [row] = await req.db.sql<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE id = ${req.params.id}`
    if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
    await assertNotLastWayIn(req.db, req.tenant, row.id)
    // Members the connection minted keep their rows and grants (FGA is untouched); only this way
    // IN dies. Recovery for an accidental delete is re-creating the connection — but the minted
    // subject_prefix derives from the NEW id, so their sign-in identities do NOT reconnect: stated,
    // and the UI warns before the delete.
    await req.db.sql`DELETE FROM tenant_oidc WHERE id = ${row.id}`
    emit({ type: 'tenant.oidc_updated', tenantId: req.tenant.id, actorId: req.user.sub, enabled: false })
    return reply.code(204).send()
  })

  app.post<{ Body: { ids?: string[] } }>('/admin/connections/reorder', async (req, reply) => {
    await requireConnectionManager(app.fga, req.user.sub, req.tenant.id)
    const ids = req.body?.ids
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== 'string')) {
      throw Object.assign(new Error('ids required'), { statusCode: 400 })
    }
    // RLS scopes the UPDATE to the tenant's rows; unknown ids are no-ops (the list view re-reads).
    await req.db.tx(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx`UPDATE tenant_oidc SET sort = ${i}, updated_at = now() WHERE id = ${ids[i]!}`
      }
    })
    return reply.code(204).send()
  })
}

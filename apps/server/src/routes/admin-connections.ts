import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { requireTenantAdmin } from '@wikistead/authz'
import { emit } from '@wikistead/events'
import { encryptSecret } from '../auth/secret-crypto.js'
import { safeFetchJson } from '../safe-fetch.js'
import { validateIssuer, type DiscoveryFetch } from './tenant-oidc.js'
import { resolveLoginConnections } from '../auth/login-methods.js'
import type { TenantDb } from '../db/index.js'

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
//   - bootstrap_eligible / trust_groups are settable HERE (the §2 rev2 "where connections are
//     created" surface) and default FALSE — flipping them is a deliberate admin act.

const PRESETS: Record<string, { issuer?: (p: { entraTenantId?: string }) => string }> = {
  google: { issuer: () => 'https://accounts.google.com' },
  microsoft: { issuer: (p) => `https://login.microsoftonline.com/${p.entraTenantId}/v2.0` },
}
const ENTRA_TENANT_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

// The label hygiene rule, exported for pins: the string renders on the UNAUTHENTICATED login
// screen, so it is bounded and stripped of the characters that lie (bidi overrides) or break
// layout (control/newline). Empty after trimming = no label.
export function sanitizeConnectionLabel(raw: unknown): { ok: true; label: string | null } | { ok: false } {
  if (raw == null || raw === '') return { ok: true, label: null }
  if (typeof raw !== 'string') return { ok: false }
  const label = raw.trim()
  if (label === '') return { ok: true, label: null }
  if (label.length > 64) return { ok: false }
  // control chars, DEL, and the bidi-override family (LRM/RLM, LRE..PDF, LRI..PDI)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(label)) return { ok: false }
  return { ok: true, label }
}

// ADR-197 §5: wc<conn8>_ — conn8 is the first 8 hex of the minted connection uuid.
export const subjectPrefixFor = (connectionId: string): string => `wc${connectionId.replace(/-/g, '').slice(0, 8)}_`

interface ConnRow {
  id: string; issuer: string; client_id: string; client_secret_enc: string | null; scopes: string
  redirect_uri: string; enabled: boolean; sort: number; label: string | null; preset: string | null
  bootstrap_eligible: boolean; trust_groups: boolean; subject_prefix: string | null; groups_claim: string | null
}
const toView = (r: ConnRow) => ({
  id: r.id, kind: 'oidc' as const, issuer: r.issuer, clientId: r.client_id, hasSecret: r.client_secret_enc != null,
  scopes: r.scopes, redirectUri: r.redirect_uri, enabled: r.enabled, sort: r.sort, label: r.label,
  preset: r.preset, bootstrapEligible: r.bootstrap_eligible, trustGroups: r.trust_groups,
  subjectPrefix: r.subject_prefix, groupsClaim: r.groups_claim,
})

// The per-connection lockout guard: would the effective list still be non-empty without `exceptId`?
// Uses the SAME resolver every login entry point consults; a not-currently-effective connection
// never triggers it (disabling it changes nothing).
async function guardNotLastWayIn(db: TenantDb, tenant: { id: string; plan: string }, exceptId: string): Promise<void> {
  const effective = await resolveLoginConnections(db, tenant)
  if (!effective.some((c) => c.id === exceptId)) return
  if (effective.filter((c) => c.id !== exceptId).length > 0) return
  throw Object.assign(
    new Error('this is the last effective way to sign in. Enable another connection first, or have an operator run `pnpm tenant:login-methods`.'),
    { statusCode: 409, code: 'login_lockout' },
  )
}

export async function adminConnectionsPlugin(app: FastifyInstance, opts?: { discoveryFetch?: DiscoveryFetch }) {
  const fetchJson = opts?.discoveryFetch ?? safeFetchJson

  app.get('/admin/connections', async (req) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const rows = await req.db.sql<ConnRow[]>`
      SELECT id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, label, preset,
             bootstrap_eligible, trust_groups, subject_prefix, groups_claim
      FROM tenant_oidc ORDER BY sort, id`
    return rows.map(toView)
  })

  app.post<{ Body: {
    preset?: string; issuer?: string; clientId?: string; clientSecret?: string | null; redirectUri?: string
    scopes?: string; label?: string; entraTenantId?: string; enabled?: boolean
    bootstrapEligible?: boolean; trustGroups?: boolean; groupsClaim?: string | null
  } }>('/admin/connections', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
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
    const enabled = b.enabled === true
    if (enabled) {
      const err = await validateIssuer(issuer, fetchJson)
      if (err) throw Object.assign(new Error(err), { statusCode: 400, code: 'oidc_unreachable' })
    }
    const id = randomUUID()
    const [{ next }] = await req.db.sql<[{ next: number }]>`
      SELECT COALESCE(MAX(sort) + 1, 0)::int AS next FROM tenant_oidc`
    await req.db.sql`
      INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, client_secret_enc, scopes, redirect_uri,
                               enabled, sort, label, preset, bootstrap_eligible, trust_groups, subject_prefix, groups_claim)
      VALUES (${id}, ${req.tenant.id}, ${issuer}, ${clientId}, ${b.clientSecret ? encryptSecret(b.clientSecret) : null},
              ${(b.scopes ?? '').trim() || 'openid email profile'}, ${redirectUri}, ${enabled},
              ${next}, ${labelRes.label}, ${preset}, ${b.bootstrapEligible === true}, ${b.trustGroups === true},
              ${subjectPrefixFor(id)}, ${b.groupsClaim?.trim() || null})
    `
    emit({ type: 'tenant.oidc_updated', tenantId: req.tenant.id, actorId: req.user.sub, enabled })
    return reply.code(201).send({ id })
  })

  app.patch<{ Params: { id: string }; Body: {
    issuer?: string; clientId?: string; clientSecret?: string | null; redirectUri?: string; scopes?: string
    label?: string | null; enabled?: boolean; bootstrapEligible?: boolean; trustGroups?: boolean; groupsClaim?: string | null
  } }>('/admin/connections/:id', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const [row] = await req.db.sql<ConnRow[]>`
      SELECT id, issuer, client_id, client_secret_enc, scopes, redirect_uri, enabled, sort, label, preset,
             bootstrap_eligible, trust_groups, subject_prefix, groups_claim
      FROM tenant_oidc WHERE id = ${req.params.id}`
    if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
    const b = req.body ?? {}
    if (row.preset !== null && b.label != null && b.label !== '') {
      throw Object.assign(new Error('a preset connection wears its own branding — labels are for preset-less connections'), { statusCode: 400 })
    }
    const labelRes = b.label !== undefined ? sanitizeConnectionLabel(b.label) : { ok: true as const, label: row.label }
    if (!labelRes.ok) throw Object.assign(new Error('invalid label'), { statusCode: 400 })
    const issuer = (b.issuer ?? row.issuer).trim()
    const enabled = b.enabled ?? row.enabled
    if (enabled && (b.enabled === true || b.issuer !== undefined)) {
      const err = await validateIssuer(issuer, fetchJson)
      if (err) throw Object.assign(new Error(err), { statusCode: 400, code: 'oidc_unreachable' })
    }
    if (b.enabled === false && row.enabled) await guardNotLastWayIn(req.db, req.tenant, row.id)
    let secretEnc = row.client_secret_enc
    if (b.clientSecret === null) secretEnc = null
    else if (b.clientSecret) secretEnc = encryptSecret(b.clientSecret)
    await req.db.sql`
      UPDATE tenant_oidc SET
        issuer = ${issuer}, client_id = ${(b.clientId ?? row.client_id).trim()}, client_secret_enc = ${secretEnc},
        scopes = ${(b.scopes ?? row.scopes).trim() || 'openid email profile'}, redirect_uri = ${(b.redirectUri ?? row.redirect_uri).trim()},
        enabled = ${enabled}, label = ${labelRes.label}, bootstrap_eligible = ${b.bootstrapEligible ?? row.bootstrap_eligible},
        trust_groups = ${b.trustGroups ?? row.trust_groups}, groups_claim = ${b.groupsClaim !== undefined ? (b.groupsClaim?.trim() || null) : row.groups_claim},
        updated_at = now()
      WHERE id = ${row.id}`
    emit({ type: 'tenant.oidc_updated', tenantId: req.tenant.id, actorId: req.user.sub, enabled })
    return reply.code(204).send()
  })

  app.delete<{ Params: { id: string } }>('/admin/connections/:id', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const [row] = await req.db.sql<{ id: string }[]>`SELECT id FROM tenant_oidc WHERE id = ${req.params.id}`
    if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 })
    await guardNotLastWayIn(req.db, req.tenant, row.id)
    // Members the connection minted keep their rows and grants (FGA is untouched); only this way
    // IN dies. Recovery for an accidental delete is re-creating the connection — but the minted
    // subject_prefix derives from the NEW id, so their sign-in identities do NOT reconnect: stated,
    // and the UI warns before the delete.
    await req.db.sql`DELETE FROM tenant_oidc WHERE id = ${row.id}`
    emit({ type: 'tenant.oidc_updated', tenantId: req.tenant.id, actorId: req.user.sub, enabled: false })
    return reply.code(204).send()
  })

  app.post<{ Body: { ids?: string[] } }>('/admin/connections/reorder', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
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

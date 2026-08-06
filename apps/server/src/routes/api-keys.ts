import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { emit } from '@wikistead/events'
import { requireTenantAdmin, isTenantAdmin, isApiKeyIssuer, filterAuthorized } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { entitlementDenied } from '../entitlement-ux.js'
import { auditIfEntitled } from '../audit/outbox.js' // #495: admin revoke writes an in-tx tamper-evident audit row
import { resolveAuthorIdentities } from '../author-identity.js' // #495 / #486: owner-name resolution on the admin list
import { enqueueWebhookOutbox } from './webhooks.js' // #495 Q3: api_key.revoked reaches subscribed webhooks
import type { TenantDb } from '../db/index.js'

export type ApiScope = 'read' | 'write'
// #496 / ADR-181: #462's `ApiKeyIssuePolicy` enum ('members' | 'admins_only') is RETIRED. Who may mint a
// key is a tenant ROLE CAPABILITY now (`issueApiKeys` → the `api_key_issue` FGA relation), so authority
// lives in OpenFGA alone instead of a settings column the UI and the gate both had to agree about. Both
// old shapes survive as tuples: 'members' == the `tenant#member` userset tuple exists, 'admins_only' ==
// it doesn't (the model's `or admin` still lets admins through) — and "only these people" is now
// expressible too, which is the whole reason for the change.

interface ApiKeyRow {
  id: string; tenant_id: string; owner_user_id: string; name: string
  key_prefix: string; scope: string | null; created_at: Date; last_used_at: Date | null; revoked_at: Date | null
  expires_at?: Date | null
  capabilities?: string[] | null
  space_ids?: string[] | null
  permission_model?: number | null
  permissions?: Record<string, string> | string | null
}
export interface ApiKeySummary {
  id: string; name: string; keyPrefix: string; scope: ApiScope; createdAt: Date; lastUsedAt: Date | null
  // #628 / ADR-215 §1: when this key stops working on its own. NULL = never — the state every key
  // issued before this feature is in, and the one a caller gets by not asking for a lifetime.
  expiresAt?: Date | null
  // #495 / ADR-182 (Q1): the ADMIN list discloses WHO owns each key so an admin can revoke a specific
  // member's key. Present only on the admin view (GET /api-keys); the self view (/api-keys/mine) omits
  // them. ownerName follows #486 (override ?? display_name; null → null, never an email fallback). The
  // key_hash / plaintext are NEVER surfaced (unchanged).
  ownerUserId?: string; ownerName?: string | null
  // #658: what this key is confined to, so the ledger can be read. Absent when the key is not confined
  // in that dimension — an unconfined key carries no marking at all, because the common case should not
  // look like the exception.
  //
  // `spaces` reports HOW MANY, and names only the ones THIS READER may view. Being handed a key does not
  // entitle anyone to a directory of space names, and neither does being an admin: #637 checks the
  // ISSUER can see a space before writing it onto a key, and the same question has to be asked on the
  // way out. A space the reader cannot view is counted and left unnamed rather than hidden entirely —
  // "confined to two spaces" is the fact an inventory needs; "which two" is a different question.
  capabilities?: readonly string[]
  spaces?: { count: number; named: { id: string; name: string }[] }
  // #667 / ADR-221 §3: which rule reads this key. `1` is the six borrowed verbs against the frozen route
  // table, `2` the resource-type matrix. Always present, because "which model" is a fact about every key
  // and a field that appears only sometimes gets read as "no model" by whoever forgets the default.
  permissionModel: 1 | 2
  permissions?: Readonly<Record<string, string>>
}

// The tenant policy cap on what scope keys may be issued with (admin-set). NULL =
// 'write' (no cap). A key's scope may never EXCEED this.
// #628 / ADR-215 §1: the tenant's ceiling on how long a key may live, in days. NULL = no ceiling, which
// is what every tenant starts with — the migration adds a column and nothing else, so no existing key
// and no existing tenant changes behaviour.
export async function getApiKeyMaxAgeDays(db: TenantDb): Promise<number | null> {
  const [row] = await db.sql<{ api_key_max_age_days: number | null }[]>`
    SELECT api_key_max_age_days FROM tenant_settings LIMIT 1
  `
  return row?.api_key_max_age_days ?? null
}

export async function setApiKeyMaxAgeDays(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; maxAgeDays: number | null },
): Promise<void> {
  await requireTenantAdmin(fga, args.userId, args.tenantId)
  const d = args.maxAgeDays
  if (d !== null && (!Number.isInteger(d) || d < 1 || d > 3650)) {
    throw Object.assign(new Error('max age must be between 1 and 3650 days, or null for no ceiling'), { statusCode: 400, code: 'invalid_max_age' })
  }
  await db.sql`
    INSERT INTO tenant_settings (tenant_id, api_key_max_age_days, updated_at)
    VALUES (${args.tenantId}, ${d}, now())
    ON CONFLICT (tenant_id) DO UPDATE SET api_key_max_age_days = ${d}, updated_at = now()
  `
}

export async function getApiKeyMaxScope(db: TenantDb): Promise<ApiScope> {
  const [row] = await db.sql<{ api_key_max_scope: string | null }[]>`
    SELECT api_key_max_scope FROM tenant_settings LIMIT 1
  `
  return row?.api_key_max_scope === 'read' ? 'read' : 'write'
}

export async function setApiKeyMaxScope(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { tenantId: string; userId: string; maxScope: ApiScope },
): Promise<void> {
  await requireTenantAdmin(fga, args.userId, args.tenantId) // #383: the shared 403 "admin only" gate
  if (args.maxScope !== 'read' && args.maxScope !== 'write') throw Object.assign(new Error('invalid scope'), { statusCode: 400 })
  await db.sql`
    INSERT INTO tenant_settings (tenant_id, api_key_max_scope, updated_at)
    VALUES (${args.tenantId}, ${args.maxScope}, now())
    ON CONFLICT (tenant_id) DO UPDATE SET api_key_max_scope = ${args.maxScope}, updated_at = now()
  `
}
export interface ApiKeyCreated extends ApiKeySummary {
  // Plaintext is returned ONCE at creation and never stored.
  plaintext: string
}

// ── Service functions ─────────────────────────────────────────────────────

// Create a new API key. Returns plaintext once — caller must display it immediately
// and never request it again; only the hash is persisted.
//
// Key format: wks_{8-char prefix}_{32-char secret}  (45 chars)
// key_prefix: used for O(1) DB lookup before hash comparison.
// key_hash:   sha256(plaintext) hex — plaintext is discarded after this call.
//
// scope (Phase 5f) restricts the key below the owner's authority; it is capped by
// the tenant policy (getApiKeyMaxScope) — requesting 'write' when the cap is 'read'
// is rejected (403). Defaults to 'write' (the owner's full authority, = pre-5f).
// #126 / ADR-063: API key creation is entitlement-gated (resolveEntitlements(plan).apiAccess).
// The gate reads the resolved boolean — no plan checks scattered (entitlement⟂authz separation).
// Which plans get apiAccess is a business placeholder; self-host (UNLIMITED) is always on.
export async function createApiKey(
  db: TenantDb,
  args: {
    tenantId: string; plan: string; ownerUserId: string; name: string; scope?: ApiScope; expiresInDays?: number | null
    // #637 / ADR-216: the narrowing dimensions. NULL is "not narrowed that way"; an empty list is
    // "narrowed to nothing". CE writes them and never decides what they MEAN — the rule and the issuing
    // route are EE, and the column is here for the reason migration 114 gives: the row has to outlive
    // the overlay, or a key issued while EE was present would widen when it is removed.
    capabilities?: readonly string[] | null
    spaces?: readonly string[] | null
    // #667 / ADR-221: the v2 matrix. Same contract as the two above — CE stores it, EE decides what may
    // be written. Its presence is what makes the row a v2 key, and the two vocabularies never mix
    // (refused at the issuing route, which is where a ledger that lies gets stopped).
    permissions?: Readonly<Record<string, string>> | null
  },
): Promise<ApiKeyCreated> {
  if (!resolveEntitlements(args.plan).apiAccess) {
    throw entitlementDenied('api', 'API keys are not available on this plan') // 403 api_not_entitled + upgrade
  }
  // #667 / ADR-221 §5: with a matrix, `scope` is DERIVED rather than asked. Every cell `read` gives a
  // read key; one `write` cell makes it a write key. The ceiling itself stays a separate mechanism —
  // it refuses a non-GET by HTTP method alone, without consulting any table — which is what #642 bought
  // and what keeps an all-read key unable to write even when the route map is wrong.
  const derived: ApiScope | undefined = args.permissions
    ? (Object.values(args.permissions).some((a) => a === 'write') ? 'write' : 'read')
    : undefined
  const scope: ApiScope = derived ?? (args.scope === 'read' ? 'read' : 'write')
  // Cap: a key may never exceed the tenant policy (deny write when capped to read).
  if (scope === 'write' && (await getApiKeyMaxScope(db)) === 'read') {
    throw Object.assign(new Error('this tenant allows read-only API keys only'), { statusCode: 403, code: 'scope_capped' })
  }
  // #628 / ADR-215 §1: the lifetime, capped by the tenant's ceiling. Asking for longer than the ceiling
  // is refused rather than quietly shortened — a caller who asked for a year and got a week would go on
  // believing they had a year, and find out when the automation stopped.
  const ceiling = await getApiKeyMaxAgeDays(db)
  const days = args.expiresInDays ?? null
  if (days !== null && (!Number.isInteger(days) || days < 1)) {
    throw Object.assign(new Error('expiresInDays must be a positive whole number of days'), { statusCode: 400, code: 'invalid_expiry' })
  }
  if (ceiling !== null && (days === null || days > ceiling)) {
    throw Object.assign(new Error(`this tenant caps API key lifetime at ${ceiling} days`), { statusCode: 403, code: 'expiry_capped' })
  }
  const prefix    = randomBytes(6).toString('base64url')   // exactly 8 chars (6 bytes → base64url)
  const secret    = randomBytes(24).toString('base64url')  // exactly 32 chars (24 bytes → base64url)
  const plaintext = `wks_${prefix}_${secret}`
  const keyPrefix = `wks_${prefix}`
  const keyHash   = createHash('sha256').update(plaintext).digest('hex')

  const [row] = await db.sql<ApiKeyRow[]>`
    INSERT INTO api_keys (tenant_id, owner_user_id, name, key_prefix, key_hash, scope, expires_at,
                          capabilities, space_ids, permission_model, permissions)
    VALUES (${args.tenantId}, ${args.ownerUserId}, ${args.name}, ${keyPrefix}, ${keyHash}, ${scope},
            ${days === null ? null : new Date(Date.now() + days * 86_400_000)},
            ${args.capabilities ? db.sql.array([...args.capabilities]) : null},
            ${args.spaces ? db.sql.array([...args.spaces]) : null},
            ${args.permissions ? 2 : 1},
            ${args.permissions ? db.sql.json(args.permissions as Record<string, string>) : null})
    RETURNING id, tenant_id, owner_user_id, name, key_prefix, scope, created_at, last_used_at, revoked_at, expires_at
  `
  const result: ApiKeyCreated = {
    id: row.id, name: row.name, keyPrefix: row.key_prefix, scope, createdAt: row.created_at,
    lastUsedAt: null, expiresAt: row.expires_at ?? null, plaintext,
    permissionModel: args.permissions ? 2 : 1,
    ...(args.permissions ? { permissions: args.permissions } : {}),
  }
  emit({ type: 'api_key.created', tenantId: args.tenantId, keyId: row.id, actorId: args.ownerUserId })
  return result
}

// List active API keys. RLS keeps this inside the tenant; `ownerUserId` narrows it to one member's
// own keys.
//
// #462: passing no owner is now an ADMIN view. It used to be the only view, and every member could
// call it — so any member could read the name, prefix, scope and last-use time of every integration
// in the tenant. Those are not secrets in the credential sense (the hash is never exposed), but they
// map out who automates what, which is nobody's business but the owner's and the admin's.
// #623 (ruling): one row per key, and integrations accumulate. Ordered with a tiebreaker so the
// bound is stable; no OFFSET anywhere in this ticket's work.
export const API_KEYS_PAGE_LIMIT = 100

export async function listApiKeys(
  db: TenantDb,
  fga: OpenFgaClient,
  readerSub: string,
  args: { ownerUserId?: string; limit?: number } = {},
): Promise<ApiKeySummary[]> {
  const owner = args.ownerUserId
  const limit = Math.min(500, Math.max(1, args.limit ?? API_KEYS_PAGE_LIMIT))
  // #495: the ADMIN view (no owner filter) also selects owner_user_id so it can disclose ownership;
  // the self view keeps its minimal columns. Both stay RLS-tenant-bound.
  const rows = owner
    ? await db.sql<ApiKeyRow[]>`
        SELECT id, name, key_prefix, scope, created_at, last_used_at, owner_user_id, expires_at,
               capabilities, space_ids, permission_model, permissions
        FROM api_keys WHERE revoked_at IS NULL AND owner_user_id = ${owner}
        ORDER BY created_at DESC, id DESC LIMIT ${limit}`
    : await db.sql<ApiKeyRow[]>`
        SELECT id, name, key_prefix, scope, created_at, last_used_at, owner_user_id, expires_at,
               capabilities, space_ids, permission_model, permissions
        FROM api_keys WHERE revoked_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT ${limit}`
  // #495 / ADR-182 (Q1): resolve owner names on the ADMIN view only — the canonical #486 helper on the
  // RLS handle (no bare pool), so null-name → null (no email fallback). The self view never discloses.
  const names = owner ? new Map<string, { displayName: string | null }>()
    : await resolveAuthorIdentities(db, rows.map((r) => r.owner_user_id))
  // #658: resolve the names ONCE for every space mentioned by any key, filtered to what the reader may
  // view. `filterAuthorized` is the same primitive the listing surfaces use, so a space the reader has
  // lost access to stops being named the moment that is true.
  const mentioned = [...new Set(rows.flatMap((r) => r.space_ids ?? []))]
  const visible = mentioned.length
    ? await filterAuthorized(fga, `user:${readerSub}`, 'view', mentioned, undefined, 'space')
    : new Set<string>()
  const spaceNames = new Map<string, string>()
  if (visible.size) {
    const named = await db.sql<{ id: string; name: string }[]>`
      SELECT id, name FROM spaces WHERE id = ANY(${[...visible]})`
    for (const s of named) spaceNames.set(s.id, s.name)
  }

  return rows.map(r => ({
    id: r.id, name: r.name, keyPrefix: r.key_prefix,
    scope: r.scope === 'read' ? 'read' : 'write',
    createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at ?? null,
    ...(owner ? {} : { ownerUserId: r.owner_user_id, ownerName: names.get(r.owner_user_id)?.displayName ?? null }),
    // #667 / ADR-221 §3: which rule reads this key, so the panel can mark the ones issued under the old
    // model and offer a replacement. Never automatic — silently upgrading a credential somebody handed
    // to an outside service is what §3 exists to prevent.
    permissionModel: r.permission_model === 2 ? 2 : 1,
    ...(r.permissions ? { permissions: typeof r.permissions === 'string' ? JSON.parse(r.permissions) as Record<string, string> : r.permissions } : {}),
    ...(r.capabilities ? { capabilities: r.capabilities } : {}),
    ...(r.space_ids
      ? {
          spaces: {
            count: r.space_ids.length,
            named: r.space_ids.flatMap((id) => {
              const name = spaceNames.get(id)
              return name ? [{ id, name }] : []
            }),
          },
        }
      : {}),
  }))
}

// Revoke a key. Only the key's owner can revoke (owner_user_id = caller's user ID).
// Returns true if revoked, false if not found / already revoked / not owned by caller.
export async function revokeApiKey(
  db: TenantDb,
  args: { id: string; ownerUserId: string },
): Promise<boolean> {
  const result = await db.sql`
    UPDATE api_keys
    SET revoked_at = now()
    WHERE id              = ${args.id}
      AND owner_user_id   = ${args.ownerUserId}
      AND revoked_at IS NULL
  `
  if (result.count > 0) {
    // Derive tenantId from db context (RLS ensures this is the correct tenant)
    const [row] = await db.sql<[{ tenant_id: string }]>`SELECT tenant_id FROM api_keys WHERE id = ${args.id}`
    if (row) emit({ type: 'api_key.revoked', tenantId: row.tenant_id, keyId: args.id, actorId: args.ownerUserId })
  }
  return result.count > 0
}

// #495 / ADR-182: a TENANT ADMIN revokes ANY member's key (no owner constraint) — the single-compromised-
// key lever the owner-only revoke could not give. RLS bounds the UPDATE to the caller's tenant, so another
// tenant's / an unknown / an already-revoked id matches 0 rows → the route returns a uniform 404 (no oracle).
// On success the tamper-evident audit row is written in the SAME tx as the revoke (auditIfEntitled, #177):
// an admin killing someone else's key IS the compliance-relevant action, and a failed audit rolls the
// revocation back (atomicity). The revocation is immediate (the `revoked_at IS NULL` auth gate). The emit
// names the admin as actor and the owner as `ownerId` so the trail reads "admin X revoked member Y's key".
export async function revokeApiKeyAsAdmin(
  db: TenantDb,
  tenant: { id: string; plan: string },
  args: { id: string; actorSub: string },
): Promise<boolean> {
  return db.tx(async (tx) => {
    const [row] = await tx<[{ owner_user_id: string }?]>`
      UPDATE api_keys SET revoked_at = now()
      WHERE id = ${args.id} AND revoked_at IS NULL
      RETURNING owner_user_id`
    if (!row) return false // 0 rows: cross-tenant (RLS) / unknown / already revoked → caller 404s
    // In-tx tamper-evident audit (#177). A throw here rolls the UPDATE back (atomic).
    await auditIfEntitled(tx, tenant, { actor: `user:${args.actorSub}`, action: 'api_key.revoked', target: `api_key:${args.id}` })
    // #495 Q3 (ruled 2026-07-24): the api_key.revoked webhook carries the affected member's identity by
    // default — ownerId (member sub) + ownerName (display) — matching the GitHub-sender / Okta-actor norm
    // for audit-class events. Resolved through the #486 resolver on the RLS handle (override ?? display_name,
    // NEVER an email, null → null; guest/anon subs are structurally dropped). This is a tenant-boundary
    // egress to an admin-configured sink, not an anonymous oracle, so no opt-in flag (simplicity, per the
    // ruling). Enqueued in the SAME tx as the revoke (the #228 webhook_outbox is transactional), so a
    // commit-then-crash still delivers and a rolled-back revoke never emits a webhook. (page.published is
    // already wired to this outbox in pages.ts and egresses actorId; this is the first event to carry a
    // RESOLVED member name — the #486 null→null / no-email contract is what keeps that safe.)
    const ownerName = (await resolveAuthorIdentities(db, [row.owner_user_id])).get(row.owner_user_id)?.displayName ?? null
    await enqueueWebhookOutbox(tx, {
      tenantId: tenant.id,
      eventType: 'api_key.revoked',
      payload: { keyId: args.id, actorId: args.actorSub, ownerId: row.owner_user_id, ownerName },
    })
    // The emit bus (in-memory audit / notifications) also names actor + owner so the internal trail reads
    // "admin X revoked member Y's key".
    emit({ type: 'api_key.revoked', tenantId: tenant.id, keyId: args.id, actorId: args.actorSub, ownerId: row.owner_user_id })
    return true
  })
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function apiKeysPlugin(app: FastifyInstance) {
  app.post<{ Body: { name: string; scope?: ApiScope; expiresInDays?: number | null } }>('/api-keys', async (req, reply) => {
    // #496 / ADR-181: ONE capability check is the gate — no settings read, no branching. The relation's
    // `or admin` arm covers what `admins_only` used to mean, the `tenant#member` userset covers `members`,
    // and a custom tenant role covers "only these people". The console hiding the button is a convenience;
    // this is the fortress. (Membership itself is settled before any route runs — #471.) The `code` is
    // surfaced so the console can say WHY it was refused (#445a silent 403 is a bug).
    if (!(await isApiKeyIssuer(app.fga, req.user.sub, req.tenant.id))) {
      throw Object.assign(new Error('api key issuance is restricted'), { statusCode: 403, code: 'api_key_issue', reason: 'api_key_issue' })
    }
    const created = await createApiKey(req.db, {
      tenantId: req.tenant.id,
      plan: req.tenant.plan,
      ownerUserId: req.user.sub,
      name: req.body.name,
      scope: req.body?.scope,
      expiresInDays: req.body?.expiresInDays ?? null,
    })
    return reply.code(201).send(created)
  })

  // The caller's OWN keys — the member self-serve surface (#462).
  app.get('/api-keys/mine', async (req) => listApiKeys(req.db, app.fga, req.user.sub, { ownerUserId: req.user.sub }))

  // Every key in the tenant: an ADMIN view. It was open to any member, which handed out a map of
  // who automates what (#462).
  app.get('/api-keys', async (req) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    return listApiKeys(req.db, app.fga, req.user.sub)
  })

  app.delete<{ Params: { id: string } }>('/api-keys/:id', async (req, reply) => {
    const revoked = await revokeApiKey(req.db, { id: req.params.id, ownerUserId: req.user.sub })
    if (!revoked) return reply.code(404).send({ error: 'not found or not owned by caller' })
    return reply.code(204).send()
  })

  // #495 / ADR-182: the ADMIN revoke door — kill ANY member's key (tenant#admin). Separate route from the
  // owner-only self-revoke above (one authority per door). A non-admin 403s here; the owner self-revoke
  // route is unchanged. Cross-tenant / unknown / already-revoked → uniform 404 (RLS 0-row).
  app.delete<{ Params: { id: string } }>('/admin/api-keys/:id', async (req, reply) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    const revoked = await revokeApiKeyAsAdmin(req.db, req.tenant, { id: req.params.id, actorSub: req.user.sub })
    if (!revoked) return reply.code(404).send({ error: 'not found' })
    return reply.code(204).send()
  })

  // Tenant API policy: who may issue, and the max scope they may issue with (tenant#admin). This is
  // an /admin/ surface, so it is admin-gated like its siblings even though the same two values reach
  // a member advisorily via /api-keys/policy — a member reads this through THAT door, not this one.
  app.get('/admin/api-policy', async (req) => {
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    // #496 / ADR-181: `issuePolicy` is gone with the enum — who may issue is configured on the Roles
    // tab now (the member toggle / a tenant role capability). Only the scope cap lives here.
    return { maxScope: await getApiKeyMaxScope(req.db), maxAgeDays: await getApiKeyMaxAgeDays(req.db) }
  })

  app.patch<{ Body: { maxScope?: ApiScope; maxAgeDays?: number | null } }>('/admin/api-policy', async (req, reply) => {
    // Admin-gate the request itself, not only each setter: an empty body would otherwise call no
    // setter and hand a non-admin a 204, which reads like success on an admin route.
    await requireTenantAdmin(app.fga, req.user.sub, req.tenant.id)
    // Either field may be sent on its own, so the two switches on the same panel do not overwrite
    // each other with a stale copy of the other's value.
    if (req.body?.maxScope !== undefined) {
      await setApiKeyMaxScope(req.db, app.fga, { tenantId: req.tenant.id, userId: req.user.sub, maxScope: req.body.maxScope })
    }
    // #628 / ADR-215 §1: `null` is a value here, not an omission — it is how a tenant REMOVES the
    // ceiling. `undefined` (the field absent) leaves it alone, which is what lets the two switches on
    // this panel be sent independently.
    if (req.body?.maxAgeDays !== undefined) {
      await setApiKeyMaxAgeDays(req.db, app.fga, { tenantId: req.tenant.id, userId: req.user.sub, maxAgeDays: req.body.maxAgeDays })
    }
    return reply.code(204).send()
  })

  // What the CALLER may do, so a member surface can show or hide its own affordance without being
  // the authority on it (the server just refused, or will refuse, either way).
  app.get('/api-keys/policy', async (req) => {
    // #496 / ADR-181: `canIssue` is the SAME check the POST gate runs (isApiKeyIssuer), so the console can
    // never show an affordance the server would refuse. The `policy` enum field is gone with the enum.
    const canIssue = await isApiKeyIssuer(app.fga, req.user.sub, req.tenant.id)
    // #628: the lifetime ceiling rides along for the same reason the scope cap does — so the form can
    // offer the lifetimes the tenant will actually accept, rather than offering all of them and letting
    // the server refuse one the member already chose.
    return { canIssue, maxScope: await getApiKeyMaxScope(req.db), maxAgeDays: await getApiKeyMaxAgeDays(req.db) }
  })
}

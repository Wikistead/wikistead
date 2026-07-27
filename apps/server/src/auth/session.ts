// Member session layer (P1.1 C2). BFF model: the browser holds an opaque,
// host-only session cookie; the session body lives in Valkey so it is revocable
// (logout / admin force-logout / removal take effect by DELETING the Valkey key
// clearing the cookie alone is not enough). Programmatic clients use Bearer
// (API key / guest token) instead; this layer is for browser members.
import { randomBytes } from 'node:crypto'
import type IORedis from 'ioredis'
import type { OpenFgaClient } from '@openfga/sdk'
import type { TenantDb } from '../db/index.js'
import { syncMemberGroups } from './group-sync.js'
import { coerceGroups } from './oidc.js'
import { enrollEligible } from './enroll-policy.js'
import { getEnrollConfig } from './enroll-domains.js'
import { enrolUnderSeatCap } from './invites.js'
import { ensurePersonalSpace } from '../routes/spaces.js'
import { evaluateDefaultRole } from '../routes/roles.js'
import { evaluateAdminMapping } from './admin-mapping.js'
import type { SearchDriver } from '../search/index.js'

export const SESSION_COOKIE = 'wks_sess'

// Cookie options. NO `domain` → host-only: a cookie set on acme.<host> is never
// sent to other.<host>, so it cannot cross the tenant boundary at the browser.
// (The server ALSO checks session.tenantId === resolved tenant — defence in depth.)
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    // domain intentionally omitted (host-only)
  }
}

// Placeholder TTLs (pre-launch; make env-configurable later, like the plan limits).
const IDLE_TTL_S = 7 * 24 * 3600 // sliding idle window (Valkey key TTL)
const ABSOLUTE_TTL_S = 30 * 24 * 3600 // hard cap from login; NEVER extended
const IDLE_REFRESH_THROTTLE_S = 3600 // re-slide at most once/hour so reads stay read-mostly

export interface SessionData {
  tenantId: string
  sub: string
  email: string | null
  role: string
  groups: string[]
  createdAt: number // epoch ms
  absExpiry: number // epoch ms = createdAt + ABSOLUTE_TTL; checked on every read
}

const key = (sid: string) => `sess:${sid}`
// Per-member index of live session ids, so removal / admin force-logout can find
// and delete EVERY session for a (tenant, sub) — clearing the cookie alone does
// not revoke a server-side session. Without this index a removed member's existing
// session would keep working until its TTL (the security gap session removal must
// close; see destroyMemberSessions). The set self-expires after the absolute
// session lifetime so dangling sids cannot accumulate forever.
const memberKey = (tenantId: string, sub: string) => `member-sess:${tenantId}:${sub}`

// Fresh 256-bit id on every login → no session fixation (a pre-auth id is never
// promoted; each established session gets a brand-new id).
// #419: the tenant's default language for server-composed strings. v1 consumers: the personal-space
// initial name ONLY (an app-wide locale default is a separate, deliberately unopened design). NULL /
// missing row / unknown value → 'en' (pre-#419 behaviour).
export async function tenantDefaultLang(db: TenantDb): Promise<'en' | 'ja'> {
  try {
    const [row] = await db.sql<[{ default_lang: string | null }?]>`
      SELECT default_lang FROM tenant_settings LIMIT 1`
    return row?.default_lang === 'ja' ? 'ja' : 'en'
  } catch {
    return 'en' // best-effort (the caller's whole block is best-effort too)
  }
}

// #419: the localized personal-space initial name. An empty display name falls back to a
// language-appropriate generic / "Personal Space").
export function personalSpaceName(displayName: string, lang: 'en' | 'ja'): string {
  if (!displayName) return lang === 'ja' ? 'マイスペース' : 'Personal Space'
  return lang === 'ja' ? `${displayName}のスペース` : `${displayName}'s Space`
}

function newSid(): string {
  return randomBytes(32).toString('base64url')
}

export async function createSession(
  valkey: IORedis,
  m: { tenantId: string; sub: string; email?: string | null; role?: string; groups?: string[] },
): Promise<string> {
  const now = Date.now()
  const data: SessionData = {
    tenantId: m.tenantId,
    sub: m.sub,
    email: m.email ?? null,
    role: m.role ?? 'member',
    groups: m.groups ?? [],
    createdAt: now,
    absExpiry: now + ABSOLUTE_TTL_S * 1000,
  }
  const sid = newSid()
  await valkey.set(key(sid), JSON.stringify(data), 'EX', IDLE_TTL_S)
  // Index this sid under (tenant, sub) for force-logout / removal. TTL the set to
  // the absolute session lifetime so it cannot outlive the longest possible session.
  await valkey.sadd(memberKey(m.tenantId, m.sub), sid)
  await valkey.expire(memberKey(m.tenantId, m.sub), ABSOLUTE_TTL_S)
  return sid
}

export async function readSession(valkey: IORedis, sid: string): Promise<SessionData | null> {
  const raw = await valkey.get(key(sid))
  if (!raw) return null
  let data: SessionData
  try {
    data = JSON.parse(raw)
  } catch {
    await valkey.del(key(sid))
    return null
  }
  if (Date.now() >= data.absExpiry) {
    await valkey.del(key(sid)) // absolute cap reached — not slidable
    return null
  }
  // Throttled sliding idle: only re-extend once the key has aged past the throttle,
  // so a read does not turn into a Valkey write on every request.
  const ttl = await valkey.ttl(key(sid))
  if (ttl >= 0 && IDLE_TTL_S - ttl > IDLE_REFRESH_THROTTLE_S) {
    await valkey.expire(key(sid), IDLE_TTL_S)
  }
  return data
}

// Real revocation: delete the Valkey entry. Callers also clear the cookie. Reads
// the session first to de-index the sid from its (tenant, sub) set (best-effort
// the entry itself is gone regardless).
export async function destroySession(valkey: IORedis, sid: string): Promise<void> {
  const raw = await valkey.get(key(sid))
  await valkey.del(key(sid))
  if (raw) {
    try {
      const d = JSON.parse(raw) as SessionData
      await valkey.srem(memberKey(d.tenantId, d.sub), sid)
    } catch { /* malformed entry — nothing to de-index */ }
  }
}

// Revoke EVERY session of a member: used on removal and admin force-logout. This
// is what makes "removed → can no longer enter" take effect immediately rather
// than at TTL expiry. Deletes each indexed session entry, then the index itself.
export async function destroyMemberSessions(valkey: IORedis, tenantId: string, sub: string): Promise<void> {
  const sids = await valkey.smembers(memberKey(tenantId, sub))
  if (sids.length > 0) await valkey.del(...sids.map(key))
  await valkey.del(memberKey(tenantId, sub))
}

// Turn already-verified identity claims into a membership-checked session.
// IDENTITY (the claims) is proven by the IdP upstream; AUTHORIZATION to enter the
// tenant is enforced HERE: throws 403 unless the subject is a provisioned member
// (FGA tenant#member). Login NEVER creates membership — it only upserts profile.
// Membership is granted elsewhere (Cloud signup P1.2 / invite P1.4).
export async function establishMemberSession(
  deps: { db: TenantDb; fga: OpenFgaClient; valkey: IORedis; searchDriver?: SearchDriver },
  tenant: { id: string; plan: string },
  claims: { sub: string; email?: string | null; emailVerified?: boolean | null; name?: string | null; picture?: string | null; groups?: string[] },
): Promise<string> {
  // tenant#member is the authority (raw relation on a tenant object — not a page/
  // space Capability — so call FGA directly). Membership = the right to enter.
  const { allowed } = await deps.fga.check({ user: `user:${claims.sub}`, relation: 'member', object: `tenant:${tenant.id}` })
  if (!allowed) {
    // #101 / ADR-034: not a member yet — AUTO-ENROL if the tenant's enrol policy admits this login. The
    // trust boundary lives in enrollEligible (domain = DNS-verified only, groups = normalised claim). The
    // seat cap is enforced by the SAME fortress as invite accept (enrolUnderSeatCap), so every new-member
    // path shares one atomic gate. invite_only (the default) → not eligible → 403, and the caller (auth /
    // saml) falls through to the invite/bootstrap paths — behaviour unchanged for existing tenants. An
    // existing member never reaches here (allowed=true above), so this adds no cost to the common path.
    const cfg = await getEnrollConfig(deps.db)
    const eligible = enrollEligible({
      policy: cfg.policy,
      email: claims.email,
      // #281 / ADR-121 §3.5: the domain policy requires the IdP's verified assertion (exactly true).
      // A caller that doesn't supply it (e.g. an IdP/protocol without the claim) falls safe to
      // invite — an operational regression for such domain-enroll tenants, accepted by review.
      emailVerified: claims.emailVerified ?? null,
      groups: coerceGroups(claims.groups, claims.sub), // re-normalise defensively (idempotent)
      verifiedDomains: cfg.verifiedDomains,
      allowedGroups: cfg.allowedGroups,
    })
    if (!eligible) throw Object.assign(new Error('not a member of this tenant'), { statusCode: 403 })
    // A NEW member goes through the shared seat fortress (advisory lock + cap + member INSERT + FGA). A
    // 402 (cap) or FGA failure rolls the tx back → no member → the caller answers as for a non-member.
    await deps.db.tx((tx) => enrolUnderSeatCap(tx, deps.fga, tenant, claims, 'member', 'auto'))
  }

  // #131 / ADR-064: a member frozen by a plan-downgrade seat overage cannot establish a session
  // (data kept; reactivated on re-upgrade). The membership tuple stays — this is a reversible
  // billing freeze, not a revocation. Checked AFTER membership, so non-members still read 403.
  const [frozen] = await deps.db.sql<{ deactivated_at: Date | null }[]>`
    SELECT deactivated_at FROM members WHERE tenant_id = ${tenant.id} AND sub = ${claims.sub}
  `
  if (frozen?.deactivated_at) {
    throw Object.assign(new Error('account deactivated by a plan change'), { statusCode: 403, code: 'member_deactivated' })
  }

  // Upsert the profile + groups, then mirror the group membership into FGA `group#member`
  // (#111). Both in one tx: if the FGA sync fails the row rolls back, so members.groups and
  // FGA stay aligned and the next login re-derives the same diff. (Login already requires FGA
  // — the membership check above — so this adds no new "FGA down" failure mode.)
  const row = await deps.db.tx(async (tx) => {
    const [prevRow] = await tx<[{ groups: string[] }?]>`
      SELECT groups FROM members WHERE tenant_id = ${tenant.id} AND sub = ${claims.sub}`
    const [r] = await tx<[{ role: string; groups: string[] }]>`
      INSERT INTO members (tenant_id, sub, email, display_name, picture_url, groups)
      VALUES (${tenant.id}, ${claims.sub}, ${claims.email ?? null}, ${claims.name ?? null}, ${claims.picture ?? null}, ${deps.db.sql.array(claims.groups ?? [])})
      ON CONFLICT (tenant_id, sub) DO UPDATE SET
        email = EXCLUDED.email, display_name = EXCLUDED.display_name, picture_url = EXCLUDED.picture_url, groups = EXCLUDED.groups, updated_at = now()
      RETURNING role, groups
    `
    await syncMemberGroups(deps.fga, tenant.id, claims.sub, prevRow?.groups ?? [], r.groups)
    return r
  })
  // #226 / ADR-106: ensure the member has an owner-only personal space (idempotent, maxSpaces-exempt).
  // BEST-EFFORT — a failure here must never block login (the space is a convenience, not a credential),
  // so it runs after the session-critical work and swallows errors. The DB UNIQUE index makes concurrent
  // first-logins race-safe. #419: the initial name is localized by the TENANT's default language (OIDC
  // claims carry no locale) — "X" / "X's Space" — v1 uses default_lang for THIS name only,
  // never as an app-wide locale default. Existing spaces are never renamed; the owner can rename freely.
  try {
    const displayName = claims.name?.trim() || claims.email?.split('@')[0] || ''
    const name = personalSpaceName(displayName, await tenantDefaultLang(deps.db))
    await ensurePersonalSpace(deps.db, deps.fga, { tenantId: tenant.id, userId: claims.sub, name, plan: tenant.plan })
  } catch { /* personal-space creation is best-effort; never block login */ }
  // #497 / ADR-183 §3: apply/refresh the tenant default role for this member (conferred when NO
  // mapping matches their groups; manual-wins; removed once a mapping matches). BEST-EFFORT and
  // sequenced AFTER the upsert tx — theassign helpers open their own tx, so this is a separate
  // transaction, never nested. It is idempotent + re-run every login, so a failure self-heals and must
  // never block sign-in. searchDriver is passed through but a tenant-scope assignment never reindexes.
  if (deps.searchDriver) {
    try {
      await evaluateDefaultRole(deps.db, deps.fga, deps.searchDriver, tenant, claims.sub, row.groups)
    } catch { /* default-role application is best-effort; it self-heals at the next login */ }
  }
  // #497 / ADR-183 §2b: materialise (or withdraw) tenant admin conferred by an IdP group. Runs on the
  // member's CURRENT groups, i.e. after the upsert above, and as its own transaction — never nested in
  // the upsert tx. Unlike the default role this is NOT swallowed silently on failure: a promotion that
  // fails is harmless (they stay a member and the next login retries), but a DEMOTION that fails leaves
  // someone holding tenant admin they should not have, so it is logged for the drift sweep to be seen
  // chasing. Login still proceeds either way — refusing to sign someone in because a group lookup broke
  // would be a self-inflicted outage, and the sweep is the backstop that does not depend on this call.
  let role = row.role
  try {
    const outcome = await evaluateAdminMapping(deps.db, deps.fga, tenant, claims.sub, row.groups)
    // The session below caches the role, so use what the evaluation just produced rather than the row
    // read before it — otherwise a member promoted at this login carries `member` until they sign in
    // again (and, worse, a demoted one carries `admin`).
    if (outcome === 'promoted') role = 'admin'
    else if (outcome === 'demoted') role = 'member'
  } catch (err) {
    console.error('[establishMemberSession] admin mapping evaluation failed (drift sweep will retry)', { tenantId: tenant.id, sub: claims.sub, err })
  }
  return createSession(deps.valkey, {
    tenantId: tenant.id,
    sub: claims.sub,
    email: claims.email ?? null,
    role,
    groups: row.groups,
  })
}

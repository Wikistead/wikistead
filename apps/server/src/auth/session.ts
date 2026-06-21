// Member session layer (P1.1 C2). BFF model: the browser holds an opaque,
// host-only session cookie; the session body lives in Valkey so it is revocable
// (logout / admin force-logout / removal take effect by DELETING the Valkey key —
// clearing the cookie alone is not enough). Programmatic clients use Bearer
// (API key / guest token) instead; this layer is for browser members.
import { randomBytes } from 'node:crypto'
import type IORedis from 'ioredis'
import type { OpenFgaClient } from '@openfga/sdk'
import type { TenantDb } from '../db/index.js'

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
// the session first to de-index the sid from its (tenant, sub) set (best-effort —
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
  deps: { db: TenantDb; fga: OpenFgaClient; valkey: IORedis },
  tenant: { id: string },
  claims: { sub: string; email?: string | null; name?: string | null; groups?: string[] },
): Promise<string> {
  // tenant#member is the authority (raw relation on a tenant object — not a page/
  // space Capability — so call FGA directly). Membership = the right to enter.
  const { allowed } = await deps.fga.check({ user: `user:${claims.sub}`, relation: 'member', object: `tenant:${tenant.id}` })
  if (!allowed) throw Object.assign(new Error('not a member of this tenant'), { statusCode: 403 })

  const [row] = await deps.db.sql<[{ role: string; groups: string[] }]>`
    INSERT INTO members (tenant_id, sub, email, display_name, groups)
    VALUES (${tenant.id}, ${claims.sub}, ${claims.email ?? null}, ${claims.name ?? null}, ${deps.db.sql.array(claims.groups ?? [])})
    ON CONFLICT (tenant_id, sub) DO UPDATE SET
      email = EXCLUDED.email, display_name = EXCLUDED.display_name, groups = EXCLUDED.groups, updated_at = now()
    RETURNING role, groups
  `
  return createSession(deps.valkey, {
    tenantId: tenant.id,
    sub: claims.sub,
    email: claims.email ?? null,
    role: row.role,
    groups: row.groups,
  })
}

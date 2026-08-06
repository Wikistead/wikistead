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

/**
 * #655 / ADR-219 §2: which door this session came through.
 *
 * NOT a two-valued "second factor: yes / no". The ruling that federated logins are out of scope cannot
 * be said in two values — an implementer reading `satisfied: false` about an OIDC session would send it
 * to an interstitial, which reverses the decision without anyone editing it. Naming the door instead
 * makes "not asked" and "asked and not answered" different facts.
 *
 * NOT called `amr` either: this product does not receive the id_token's `amr` (`oidc.ts` discards it),
 * and borrowing the name would claim a provenance nothing here established.
 *
 * ABSENT reads as `local` — see `doorOf`. Nothing enforces any of this yet; the value is recorded and
 * unread, which is the whole of this slice.
 */
export type SessionDoor =
  | 'local'         // the product's own password door, with no second factor behind it
  | 'local+factor'  // …and a second factor was answered
  | 'federated'     // an IdP said who this is (OIDC or SAML) — out of the policy's scope by ADR-219 §3
  | 'operator'      // the break-glass path, which crosses requirements on purpose

export interface SessionData {
  tenantId: string
  sub: string
  email: string | null
  role: string
  groups: string[]
  createdAt: number // epoch ms
  absExpiry: number // epoch ms = createdAt + ABSOLUTE_TTL; checked on every read
  /** Absent on every session written before #655; read it through `doorOf`, never directly. */
  door?: SessionDoor
}

/**
 * The door a session came through, for sessions that predate the field.
 *
 * An old cookie reads as `local` — the value that will one day be asked for a factor — rather than as
 * anything satisfied. Grandfathering would have made "hold a cookie from last week" the way around a
 * requirement introduced this week, which is the shape of a bypass rather than of a migration.
 */
export function doorOf(s: Pick<SessionData, 'door'>): SessionDoor {
  return s.door ?? 'local'
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
  m: { tenantId: string; sub: string; email?: string | null; role?: string; groups?: string[]; door?: SessionDoor },
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
    // Omitted rather than defaulted here: a caller that does not say reads back as `local` through
    // `doorOf`, and writing a default at this depth would hide which callers had been wired.
    ...(m.door ? { door: m.door } : {}),
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
export async function destroyMemberSessions(
  valkey: IORedis, tenantId: string, sub: string,
  // #568 / ADR-198 §6: keep ONE session alive — the one that just changed the password. Signing
  // someone out of the tab they are typing in punishes them for securing their account, and they
  // would simply sign back in with the password they just set, which revokes nothing.
  exceptSid?: string,
): Promise<void> {
  const sids = await valkey.smembers(memberKey(tenantId, sub))
  const doomed = exceptSid ? sids.filter((s) => s !== exceptSid) : sids
  if (doomed.length > 0) await valkey.del(...doomed.map(key))
  // #568 review N4: when a session is SPARED, remove only the doomed ones from the index rather than
  // deleting it and adding the survivor back — between those two writes the survivor is invisible,
  // and a removal landing in that gap would miss it. When nothing is spared the index goes whole.
  if (exceptSid && sids.includes(exceptSid)) {
    if (doomed.length > 0) await valkey.srem(memberKey(tenantId, sub), ...doomed)
  } else {
    await valkey.del(memberKey(tenantId, sub))
  }
}

/**
 * Revoke the sessions a newly-enabled second-factor requirement would refuse at the door.
 *
 * ADR-219 §2: "Turning the policy on destroys the sessions of members with no factor enrolled. They
 * sign in again and land in the interstitial. Leaving them alive would be a policy that starts applying
 * tomorrow." Enforcement lives at the door (`auth-local.ts`), so without this the switch changes nothing
 * for anybody currently signed in — which is exactly the shape of a policy that looks on and is not.
 *
 * Filtered by DOOR rather than by member, deliberately. The ADR names members with no factor, and §3
 * puts federated sign-ins outside the policy altogether: revoking those would sign out every OIDC member
 * in the tenant to no end — they would sign back in through the same door and be admitted. A session
 * with no recorded door reads as `local` (§2's "never grandfathered"), so deployments predating the
 * field are swept, not spared.
 *
 * Best-effort per session and never in the caller's transaction: a stance that was written must not be
 * rolled back because one revocation failed, and the door refuses these sessions from now on regardless.
 */
/**
 * The doors a second-factor stance may close (#679).
 *
 * An allowlist, not "everything except the federated one". `federated` is out of scope by ADR-219 §3 —
 * an identity provider said who this is and the product does not add to that — and `operator` is the
 * break-glass path (#605), which crosses requirements on purpose and is the way back in when a policy
 * has locked somebody out. Both are exclusions this policy must never reach; naming what it DOES reach
 * means a fourth door has to be thought about rather than swept by default.
 */
const SWEEPABLE_DOORS: SessionDoor[] = ['local', 'local+factor']

export async function destroyUnsatisfiedSessions(
  valkey: IORedis, tenantId: string, subs: string[],
): Promise<number> {
  let revoked = 0
  for (const sub of subs) {
    const sids = await valkey.smembers(memberKey(tenantId, sub)).catch(() => [] as string[])
    for (const sid of sids) {
      const raw = await valkey.get(key(sid)).catch(() => null)
      if (!raw) {
        await valkey.srem(memberKey(tenantId, sub), sid).catch(() => {}) // expired: tidy the index
        continue
      }
      try {
        // #679: the doors this policy reaches, named rather than described as "not federated".
        //
        // `local+factor` is the fix. It means the member answered the stance in force when they signed
        // in — which, on a NARROWING, is precisely the person the new stance refuses. Skipping them was
        // right while the stance was a single bit (somebody who had answered could not be in the
        // unsatisfied set at all), and #679 widened the set to ask about KINDS without widening this.
        // Half a widening: the set names them, the filter drops them, and they keep a live session
        // under a stance the door will now refuse — the policy-that-starts-tomorrow ADR-219 §2
        // rejected, and what ruling ④ (immediate sign-out) is about.
        //
        // The other two doors stay, and an ALLOWLIST is why this comment can say so. Written as "not
        // federated" it swept `operator` as well — the break-glass path, which crosses requirements on
        // purpose (#605) and is somebody's way back in when the policy has gone wrong. #652's pin
        // caught that within a minute; a fourth door added next year would not be so lucky, and would
        // silently join the sweep by default. Naming the set means a new door has to be considered.
        if (!SWEEPABLE_DOORS.includes(doorOf(JSON.parse(raw) as SessionData))) continue
      } catch { /* malformed: treat as unsatisfied, below */ }
      await valkey.del(key(sid)).catch(() => {})
      await valkey.srem(memberKey(tenantId, sub), sid).catch(() => {})
      revoked++
    }
  }
  return revoked
}

/**
 * How many of these members hold a session the sweep would take (#679).
 *
 * The same rule `destroyUnsatisfiedSessions` applies, asked without taking anything: only `local`-door
 * sessions count, because the others are not the policy's business (ADR-219 §3, §4). Counting members
 * rather than sessions would say "12 will be signed out" about eight people, and counting every member
 * without a factor would say it about people who were not signed in at all.
 */
export async function countSweptSessions(
  valkey: IORedis, tenantId: string, subs: string[],
): Promise<number> {
  let n = 0
  for (const sub of subs) {
    const sids = await valkey.smembers(memberKey(tenantId, sub)).catch(() => [] as string[])
    for (const sid of sids) {
      const raw = await valkey.get(key(sid)).catch(() => null)
      if (!raw) continue
      try {
        // The same list as the sweep, and it has to STAY the same list: this number is shown to an
        // admin deciding whether to narrow, and a count drawn from a different question is a promise
        // about a different act.
        if (SWEEPABLE_DOORS.includes(doorOf(JSON.parse(raw) as SessionData))) { n++; break }
      } catch { n++; break } // malformed reads as unsatisfied, exactly as the sweep treats it
    }
  }
  return n
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
  // #554 S4 / ADR-197 §5 rev3 (the gate flip): true ONLY when the CALLER validated the raw
  // external sub and minted the namespaced form (wc<conn8>_<raw>) itself — the gate below would
  // otherwise refuse the very subs this seam exists to protect. Never set from request data.
  opts?: {
    subMintedInternally?: boolean
    // #568 / ADR-198 §0 §3: this identity is OURS — a local member signing in with a password. Two
    // things must not happen on that path. It must not AUTO-ENROL (a password proves who you are;
    // membership was decided when the invite was accepted, and re-deciding it here would let the
    // enrol policy admit someone through a door that has no IdP behind it), and it must not upsert
    // the PROFILE from claims (there are no claims — an OIDC login refreshes name/picture/groups
    // from the IdP at every sign-in; a local member's profile is their own to edit, ADR-190).
    localIdentity?: boolean
    // #655 / ADR-219 §2: which door the caller opened. Left optional because an absent value reads as
    // `local` — the unsatisfied end — so a path that forgets is answered conservatively rather than
    // handed a pass. All five product callers name it; a pin holds them to that.
    door?: SessionDoor
  },
): Promise<string> {
  // #554 / ADR-197 §5 (S0): the reserved internal sub space — an externally-asserted subject that
  // wears a future connection's prefix (or exceeds the FGA-safe length) is refused with this seam's
  // own failure (a non-member 403), never a distinguishable oracle.
  if (!opts?.subMintedInternally && !opts?.localIdentity) {
    const { assertExternalSub } = await import('./reserved-subs.js')
    assertExternalSub(claims.sub, () => Object.assign(new Error('not a member of this tenant'), { statusCode: 403 }))
  }
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
    // A local sign-in never creates membership (see localIdentity above): a non-member gets the
    // same 403 a non-member always got.
    if (opts?.localIdentity) throw Object.assign(new Error('not a member of this tenant'), { statusCode: 403 })
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
  // A local session READS the member row it already has; an OIDC one rewrites it from the claims it
  // just received. Sharing the write here would have a password login blank out the display name the
  // member set for themselves.
  const localRow = opts?.localIdentity
    ? (await deps.db.sql<{ role: string; groups: string[] }[]>`
        SELECT role, groups FROM members WHERE tenant_id = ${tenant.id} AND sub = ${claims.sub}`)[0]
    : undefined
  // #568 review N2: FGA said member and the row is not there (a partially-applied removal, a manual
  // tuple). Reading `.role` off nothing is a 500 that tells the caller something went wrong INSIDE;
  // the honest answer is the one a non-member gets.
  if (opts?.localIdentity && !localRow) {
    throw Object.assign(new Error('not a member of this tenant'), { statusCode: 403 })
  }
  const row = opts?.localIdentity
    ? localRow!
    : await deps.db.tx(async (tx) => {
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
  // #578 / ADR-201 slice 5: the default role is retired. The tenant vocabulary is `createSpaces` and
  // `issueApiKeys`, and the same admin screen already has an every-member toggle for each — the two
  // said the same thing. Existing defaults were converted by migration 100 plus the one-shot toggle
  // script, so nobody lost a capability when this call went away.
  // #578 / ADR-201 slice 4: login no longer materialises tenant admin from an IdP group. ADR-183 had
  // adopted that path and ADR-201 abolished it, for ADR-183's own stated reasons: whoever can edit the
  // group at the IdP takes the tenant, nothing records who holds it, and revocation lives outside the
  // product. Existing group-derived admins were converted to `manual` by migration 099 rather than
  // stripped, so nobody lost administration when this call went away.
  const role = row.role
  return createSession(deps.valkey, {
    tenantId: tenant.id,
    sub: claims.sub,
    email: claims.email ?? null,
    role,
    groups: row.groups,
    ...(opts?.door ? { door: opts.door } : {}),
  })
}

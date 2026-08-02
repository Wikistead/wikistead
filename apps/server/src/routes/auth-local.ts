// Password sign-in for local members (#568 / ADR-198 §3 §5).
//
// The route is deliberately boring: look the credential up, verify it, hand the subject to the same
// session machinery every other method uses. What is NOT boring, and is the reason this file has more
// comment than code, is everything it must refuse to reveal.
//
// ONE refusal for every cause — unknown identifier, wrong password, locked out, deactivated member,
// local login switched off for this tenant. They all answer `401 { error: 'invalid credentials' }`
// after burning a REAL scrypt verification, because an early return is a timing oracle that answers
// "does this account exist here?" without needing the password. The dummy hash exists for exactly
// that (password-hash.ts).
//
// The lock is read BEFORE the credential is verified (the share-link precedent's `peekRateBucket`
// shape), and a CORRECT password during a lockout clears nothing: otherwise the lockout is a delay
// for whoever eventually guesses right, rather than a stop.
import type { FastifyInstance } from 'fastify'
import type IORedis from 'ioredis'
import { emit } from '@wikistead/events'
import { SESSION_COOKIE, establishMemberSession, sessionCookieOptions } from '../auth/session.js'
import { localLoginEnabled } from '../auth/login-methods.js'
import { hashPassword, verifyPassword, needsRehash, dummyHash } from '../auth/password-hash.js'
import { safeReturnTo } from '../auth/return-to.js'

// ADR-198 §5, ruled on #568: an identifier is locked after 5 failures in 15 minutes, an IP after 30,
// and a lock lasts 30 minutes. Env-overridable because the e2e and server suites hammer this path
// from one address, and a suite that trips a production-shaped limit tests the limiter, not the
// product. The lock ALWAYS expires on its own (the ruling's "automatic unlock"): an admin action is
// never required to get back in.
const num = (env: string | undefined, fallback: number) => {
  const n = Number(env)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
export const LOCAL_LOGIN_ID_MAX = num(process.env.LOCAL_LOGIN_ID_MAX, 5)
export const LOCAL_LOGIN_IP_MAX = num(process.env.LOCAL_LOGIN_IP_MAX, 30)
export const LOCAL_LOGIN_WINDOW_S = num(process.env.LOCAL_LOGIN_WINDOW_S, 15 * 60)
export const LOCAL_LOGIN_LOCK_S = num(process.env.LOCAL_LOGIN_LOCK_S, 30 * 60)

// READ a counter without incrementing (C2: the lock must be consulted before the password is even
// looked at). A Valkey failure here FAILS CLOSED — a limiter that disappears under load is not a
// limiter — but says so in the log rather than pretending the account is locked.
async function overLimit(valkey: IORedis, key: string, max: number): Promise<boolean> {
  try {
    const n = Number(await valkey.get(key))
    return Number.isFinite(n) && n >= max
  } catch (err) {
    console.error('[auth:local] rate counter unreadable — refusing (fail closed)', err)
    return true
  }
}

// Count a failure. First hit in a window sets the expiry, so the window slides forward only when it
// empties — a fixed window, like every other bucket in this codebase.
async function countFailure(valkey: IORedis, key: string, windowS: number): Promise<void> {
  try {
    const n = await valkey.incr(key)
    if (n === 1) await valkey.expire(key, windowS)
  } catch (err) {
    console.error('[auth:local] rate counter unwritable — a failure went uncounted', err)
  }
}

// #568 §3 C5: a cross-site form must not be able to log a victim into an attacker's account (which is
// how a session-fixation-flavoured attack starts: the victim then writes into the attacker's tenant
// thinking it is theirs). Same-origin proof, in the order browsers actually send it. A request with
// NEITHER header is refused: every browser that can reach this route sends at least one, so what is
// left is a non-browser client, which has no business establishing a cookie session.
export function sameOriginOk(headers: Record<string, unknown>, host: string | undefined): boolean {
  const fetchSite = headers['sec-fetch-site']
  if (typeof fetchSite === 'string') return fetchSite === 'same-origin' || fetchSite === 'none'
  const origin = headers.origin
  if (typeof origin === 'string' && host) {
    try { return new URL(origin).host === host } catch { return false }
  }
  return false
}

export async function authLocalPlugin(app: FastifyInstance) {
  // Host-resolved tenant, no session required — this is where a session comes from.
  app.post<{ Body: { identifier?: string; password?: string; returnTo?: string } }>(
    '/auth/local/login', { config: { public: true } }, async (req, reply) => {
      const deny = () => reply.code(401).send({ error: 'invalid credentials' })
      if (!sameOriginOk(req.headers as Record<string, unknown>, req.headers.host)) {
        // Not a credential failure: nothing was checked, so nothing is counted and no event fires.
        return reply.code(403).send({ error: 'forbidden' })
      }
      const identifier = (req.body?.identifier ?? '').trim().toLowerCase()
      const password = req.body?.password ?? ''
      if (!identifier || !password) return deny()

      const ip = req.ip
      const idKey = `rl:local:id:${req.tenant.id}:${identifier}`
      const ipKey = `rl:local:ip:${req.tenant.id}:${ip}`
      const lockKey = `lock:local:${req.tenant.id}:${identifier}`

      // ── C2: the lock is evaluated BEFORE anything is verified ──────────────
      const locked = await overLimit(app.valkey, lockKey, 1)
      const ipFlooded = await overLimit(app.valkey, ipKey, LOCAL_LOGIN_IP_MAX)

      // The credential row is read even when locked, because the refusal must cost the same either
      // way (a "locked" branch that skips the KDF is the timing oracle C1 closes).
      const enabled = await localLoginEnabled(req.db)
      const [row] = enabled
        ? await req.db.sql<{ member_sub: string; password_hash: string }[]>`
            SELECT member_sub, password_hash FROM local_credentials WHERE identifier = ${identifier}`
        : []
      // An unknown identifier (or local login switched off) verifies against a real hash nobody holds.
      const stored = row?.password_hash ?? (await dummyHash())
      const ok = await verifyPassword(password, stored)

      if (locked || ipFlooded || !enabled || !row || !ok) {
        // A correct password during a lockout clears NOTHING (C2) — it is still a failure here.
        await countFailure(app.valkey, idKey, LOCAL_LOGIN_WINDOW_S)
        await countFailure(app.valkey, ipKey, LOCAL_LOGIN_WINDOW_S)
        if (!locked && (await overLimit(app.valkey, idKey, LOCAL_LOGIN_ID_MAX))) {
          // Trip the lock. It expires on its own — no admin action is needed to get back in.
          await app.valkey.set(lockKey, '1', 'EX', LOCAL_LOGIN_LOCK_S).catch(() => {})
          emit({ type: 'member.locked', tenantId: req.tenant.id, identifier })
        }
        // The event names the METHOD; the reason stays coarse deliberately — a webhook stream that
        // distinguished "no such account" from "wrong password" would be the enumeration oracle the
        // uniform response just closed.
        emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'local', reason: 'invalid credentials' })
        return deny()
      }

      // Success: the counters for this identifier go, so a legitimate user who mistyped twice is not
      // one failure away from a lock for the next quarter of an hour. The IP counter STAYS — it
      // counts a source's behaviour, and one success does not vouch for the rest.
      await app.valkey.del(idKey).catch(() => {})

      // Opportunistic upgrade: the only moment the plaintext is in hand (ADR-198 §4).
      if (needsRehash(stored)) {
        const fresh = await hashPassword(password)
        await req.db.sql`UPDATE local_credentials SET password_hash = ${fresh}, updated_at = now() WHERE member_sub = ${row.member_sub}`
          .catch((err: unknown) => console.error('[auth:local] re-hash failed (login still succeeds)', err))
      }

      // Membership is still the authority: `localIdentity` tells the session machinery this subject
      // is ours (skip the external-sub gate), that it must NOT auto-enrol (a password proves who you
      // are, not that you belong), and that there are no claims to overwrite the profile with.
      const sid = await establishMemberSession(
        { db: req.db, fga: app.fga, valkey: app.valkey, searchDriver: app.searchDriver },
        req.tenant,
        { sub: row.member_sub },
        { localIdentity: true },
      )
      reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions())
      return { ok: true, returnTo: safeReturnTo(req.body?.returnTo) }
    },
  )
}

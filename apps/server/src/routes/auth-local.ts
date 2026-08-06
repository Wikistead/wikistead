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
import { auditIfEntitled } from '../audit/outbox.js'
import { SESSION_COOKIE, destroyMemberSessions, establishMemberSession, sessionCookieOptions } from '../auth/session.js'
import { FACTOR_COOKIE, createFactorSession, readFactorSession, destroyFactorSession, factorCookieOptions } from '../auth/factor-session.js' // #652 / ADR-219 §6
import { passkeyAuthenticationOptions, verifyPasskeyAssertion } from '../auth/passkeys.js' // #665
import { secondFactorRequired, presentableHere } from '../auth/factor-policy.js'
import { hasConfirmedFactor, totpSecretFor, spendTotpCounter, markFactorUsed, startTotpEnrolment, confirmFactor } from '../auth/second-factors.js'
import { verifyTotp, generateTotpSecret, totpUri } from '../auth/totp.js'
import { localLoginEnabled, loginMethodCeiling } from '../auth/login-methods.js'
import { hashPassword, verifyPassword, needsRehash, dummyHash } from '../auth/password-hash.js'
import { safeReturnTo } from '../auth/return-to.js'
import { validatePasswordPolicy, PASSWORD_MIN_LENGTH } from '../auth/password-policy.js'
import { productName } from '../product-name.js'

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
// A reset asks the product to send mail to an address the caller named, so the per-ADDRESS limit is
// tighter than a login's: it bounds how often anyone can be mailed, not how often a password is
// guessed.
export const RESET_REQ_ADDR_MAX = num(process.env.LOCAL_RESET_ADDR_MAX, 3)
// RFC 5321's ceiling on an address. An identifier longer than this cannot match a credential, and
// letting one through would put attacker-chosen bytes into a Valkey key and a webhook payload.
export const MAX_IDENTIFIER_LEN = 320

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
  // #568 review B2: what KIND of invite is this link? The landing page has an opaque token and no
  // way to know whether to send the person to an IdP or ask them to choose a password — and sending
  // a password invite to the IdP burned the token on an OIDC seat, leaving the credential the invite
  // existed to create unwritten, with nothing telling either party.
  //
  // Answering is not a disclosure: holding the token IS the capability, so its holder learning what
  // to do with it tells them nothing they do not already have. A token that is unknown, expired,
  // consumed or revoked gets the same 404 every other invite surface gives.
  app.get<{ Querystring: { token?: string } }>('/auth/invite-kind', { config: { public: true } }, async (req, reply) => {
    const token = (req.query?.token ?? '').trim()
    if (!token) return reply.code(404).send({ error: 'invite not available' })
    const { hashInviteToken } = await import('../auth/invites.js')
    const [row] = await req.db.sql<{ kind: string }[]>`
      SELECT kind FROM invites
       WHERE token_hash = ${hashInviteToken(token)} AND status = 'pending' AND expires_at > now()`
    if (!row) return reply.code(404).send({ error: 'invite not available' })
    return { kind: row.kind }
  })

  // #568 / ADR-198 §2: accept a password invite. Unauthenticated and token-addressed — the person
  // holding the link is not a member yet, which is the whole point.
  //
  // Every refusal answers the SAME shape: an unknown, expired, consumed or revoked token, a token for
  // an OIDC invite, and a tenant that has since switched password sign-in off are one response. The
  // holder of a dead link learns "this link does not work", never anything about the tenant.
  app.post<{ Body: { token?: string; password?: string } }>(
    '/auth/local/accept', { config: { public: true } }, async (req, reply) => {
      // #613 / ADR-198 §3 M8: the deployment CEILING gates the endpoint, not just the screen. Same
      // uniform not-found as the OIDC/SAML surfaces (ADR-195 §7) — a deployment that excludes `local`
      // has no password attack surface, and no probe learns the method exists. A DIFFERENT predicate
      // from the #605 stance on purpose: the stance is tenant policy and lets exemptions through; the
      // ceiling is deployment policy and admits no exceptions.
      if (!loginMethodCeiling().has('local')) return reply.code(404).send({ error: 'not found' })
      if (!sameOriginOk(req.headers as Record<string, unknown>, req.headers.host)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      const token = (req.body?.token ?? '').trim()
      const password = req.body?.password ?? ''
      if (!token) return reply.code(404).send({ error: 'invite not available' })
      // The policy failure is its own answer, and deliberately so: the person is choosing a password
      // right now and needs to know it was too short. It says nothing about the invite.
      if (!validatePasswordPolicy(password)) {
        return reply.code(400).send({ error: `password must be at least ${PASSWORD_MIN_LENGTH} characters`, code: 'weak_password' })
      }
      // Accepting mints a member: rate-limit by source so a leaked-token guessing run cannot seat
      // accounts as fast as it can POST.
      if (await overLimit(app.valkey, `rl:local:accept:${req.tenant.id}:${req.ip}`, LOCAL_LOGIN_IP_MAX)) {
        return reply.code(404).send({ error: 'invite not available' })
      }
      await countFailure(app.valkey, `rl:local:accept:${req.tenant.id}:${req.ip}`, LOCAL_LOGIN_WINDOW_S)

      const { acceptLocalInvite } = await import('../auth/invites.js')
      let outcome: Awaited<ReturnType<typeof acceptLocalInvite>>
      try {
        outcome = await acceptLocalInvite({ db: req.db, fga: app.fga }, req.tenant, token, password)
      } catch (e) {
        // A seat-cap refusal is its own answer (402), as it is for every other acceptance path: it is
        // about the tenant's plan, not about whether the link is real.
        if ((e as { code?: string }).code === 'seat_limit') return reply.code(402).send({ error: 'seat limit reached', code: 'seat_limit' })
        throw e
      }
      if (!outcome.ok) return reply.code(404).send({ error: 'invite not available' })

      const sid = await establishMemberSession(
        { db: req.db, fga: app.fga, valkey: app.valkey, searchDriver: app.searchDriver },
        req.tenant,
        { sub: outcome.sub },
        // #655: which door this was. An operator break-glass invite is the one #616 exempted from the
        // SSO stance, and ADR-219 §4 gives it the same standing against the second-factor requirement:
        // the way back in when everything else is shut must not be shut by the thing it exists to get
        // around. Every other acceptance is the product's own password door — `local` rather than
        // `local+factor`, because nothing has asked for a factor and claiming one was answered would
        // be the first lie the enforcement slice reads.
        { localIdentity: true, door: outcome.operatorIssued ? 'operator' : 'local' },
      )
      reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions())
      return reply.code(201).send({ ok: true })
    },
  )

  // #568 / ADR-198 §6: ASK for a reset link. Unauthenticated, and its entire job is to say nothing.
  //
  // The answer is 204 whatever happened: the address belongs to a password account and mail went
  // out, it belongs to an OIDC member, it belongs to nobody, or the tenant does not offer passwords
  // at all. Anything else turns this into the account-enumeration endpoint that every other surface
  // here is careful not to be — and it is unauthenticated, so it is the cheapest one to ask.
  //
  // Rate-limited on BOTH sides: per address, so nobody can be mail-bombed by repeating one, and per
  // source, so a list of addresses cannot be walked. Both refusals are the same 204.
  app.post<{ Body: { identifier?: string } }>('/auth/local/reset-request', { config: { public: true } }, async (req, reply) => {
      // #613 / ADR-198 §3 M8: the deployment CEILING gates the endpoint, not just the screen. Same
      // uniform not-found as the OIDC/SAML surfaces (ADR-195 §7) — a deployment that excludes `local`
      // has no password attack surface, and no probe learns the method exists. A DIFFERENT predicate
      // from the #605 stance on purpose: the stance is tenant policy and lets exemptions through; the
      // ceiling is deployment policy and admits no exceptions.
      if (!loginMethodCeiling().has('local')) return reply.code(404).send({ error: 'not found' })

    if (!sameOriginOk(req.headers as Record<string, unknown>, req.headers.host)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const identifier = (req.body?.identifier ?? '').trim().toLowerCase()
    const silence = () => reply.code(204).send()
    // Bounded here too (review): this identifier also becomes a Valkey key.
    if (!identifier || identifier.length > MAX_IDENTIFIER_LEN) return silence()

    const addrKey = `rl:local:reset:addr:${req.tenant.id}:${identifier}`
    const ipKey = `rl:local:reset:ip:${req.tenant.id}:${req.ip}`
    if (await overLimit(app.valkey, addrKey, RESET_REQ_ADDR_MAX)) return silence()
    if (await overLimit(app.valkey, ipKey, LOCAL_LOGIN_IP_MAX)) return silence()
    await countFailure(app.valkey, addrKey, LOCAL_LOGIN_WINDOW_S)
    await countFailure(app.valkey, ipKey, LOCAL_LOGIN_WINDOW_S)

    const { mintPasswordReset } = await import('../auth/password-reset.js')
    const minted = await mintPasswordReset(req.db, req.tenant, identifier)
    if (!minted) return silence()

    // Sent DIRECTLY, not through the notification outbox: that outbox stores a pointer rather than a
    // body, so a link could not be reconstructed from a queued row (ADR-198 §6 rev3). A send failure
    // is logged and still answers 204 — the caller must not learn that an address exists from a
    // delivery problem.
    const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http'
    const link = `${scheme}://${req.headers.host}/reset-password?token=${minted.token}`
    // review R1, measured: AWAITING the send made this endpoint answer in ~60ms for an address that
    // exists and ~2ms for one that does not. The status was uniform and the CLOCK was not, which is
    // the same oracle by a slower channel. The send is fired and not waited on; a failure is logged.
    void (async () => {
      const { resolveTenantEmailDriver } = await import('@wikistead/hooks')
      await resolveTenantEmailDriver({ tenantId: req.tenant.id, plan: req.tenant.plan }, req.server.email).send({
        to: minted.email,
        subject: `Reset your ${productName()} password`,
        text: `Someone asked to reset the password for this address. Open this link within the hour:\n\n${link}\n\nIf it was not you, you can ignore this — nothing has changed.`,
        html: `<p>Someone asked to reset the password for this address.</p><p><a href="${link}">Choose a new password</a> (the link works for one hour).</p><p>If it was not you, you can ignore this — nothing has changed.</p>`,
      })
    })().catch((err) => req.log.warn({ err }, 'password reset email failed to send'))
    // Audited by SUB, so the ledger records who a reset was requested for — the first thing an
    // account-takeover investigation asks. The webhook stream carries the same fact.
    // ADR-198 §6 C7: the EE ledger, not only the webhook stream. "When was a reset asked for, and
    // for whom" is the first question an account-takeover investigation has.
    // review F2: the ACTOR is not the member. This endpoint is unauthenticated and anyone may type
    // anyone's address into it, so recording `user:<them>` would tell an account-takeover
    // investigation that the owner asked for this — the opposite of what the ledger knows. The
    // request came from nobody we can name; the member is the TARGET.
    await req.db.tx((tx) => auditIfEntitled(tx, req.tenant, {
      actor: 'anonymous', action: 'member.password_reset_requested', target: `member:${minted.memberSub}`,
    })).catch((err: unknown) => req.log.warn({ err }, 'reset-request audit failed'))
    emit({ type: 'member.password_reset_requested', tenantId: req.tenant.id, targetSub: minted.memberSub })
    return silence()
  })

  // #568 / ADR-198 §6: COMPLETE a reset. Unauthenticated and token-addressed; a dead link and a
  // tenant that switched passwords off answer identically, and only the policy failure is its own
  // answer (the person is choosing a password right now).
  app.post<{ Body: { token?: string; password?: string } }>('/auth/local/reset', { config: { public: true } }, async (req, reply) => {
      // #613 / ADR-198 §3 M8: the deployment CEILING gates the endpoint, not just the screen. Same
      // uniform not-found as the OIDC/SAML surfaces (ADR-195 §7) — a deployment that excludes `local`
      // has no password attack surface, and no probe learns the method exists. A DIFFERENT predicate
      // from the #605 stance on purpose: the stance is tenant policy and lets exemptions through; the
      // ceiling is deployment policy and admits no exceptions.
      if (!loginMethodCeiling().has('local')) return reply.code(404).send({ error: 'not found' })

    if (!sameOriginOk(req.headers as Record<string, unknown>, req.headers.host)) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const token = (req.body?.token ?? '').trim()
    const password = req.body?.password ?? ''
    if (!token) return reply.code(404).send({ error: 'link not available' })
    if (!validatePasswordPolicy(password)) {
      return reply.code(400).send({ error: `password must be at least ${PASSWORD_MIN_LENGTH} characters`, code: 'weak_password' })
    }
    if (await overLimit(app.valkey, `rl:local:reset:use:${req.tenant.id}:${req.ip}`, LOCAL_LOGIN_IP_MAX)) {
      return reply.code(404).send({ error: 'link not available' })
    }
    await countFailure(app.valkey, `rl:local:reset:use:${req.tenant.id}:${req.ip}`, LOCAL_LOGIN_WINDOW_S)

    const { completePasswordReset } = await import('../auth/password-reset.js')
    const done = await completePasswordReset(req.db, req.tenant, token, password)
    if (!done) return reply.code(404).send({ error: 'link not available' })

    // A reset is what someone does when they think another person is in their account: EVERY session
    // goes, including any the attacker holds. Nothing is spared here — unlike a change, the person
    // completing this is not signed in.
    await destroyMemberSessions(app.valkey, req.tenant.id, done.memberSub)
    // The lockout goes too — for THIS member. review R2, measured: this used to read the identifier
    // from the request BODY, an undeclared field nobody sends, so any local member could complete
    // their own reset while naming a victim and clear that victim's lock. Five guesses, a reset,
    // five more: the §5 lockout was off for anyone with an account. The identifier now comes from
    // the credential the reset just rewrote, which is the only one it can possibly be about.
    const [cred] = await req.db.sql<{ identifier: string }[]>`
      SELECT identifier FROM local_credentials WHERE member_sub = ${done.memberSub}`
    if (cred) {
      await app.valkey.del(`lock:local:${req.tenant.id}:${cred.identifier}`).catch(() => {})
      await app.valkey.del(`rl:local:id:${req.tenant.id}:${cred.identifier}`).catch(() => {})
    }
    emit({ type: 'member.password_reset_completed', tenantId: req.tenant.id, targetSub: done.memberSub })
    return reply.code(204).send()
  })

  // #568 / ADR-198 §6: change your own password. Authenticated, and it asks for the CURRENT one —
  // a live session is not proof that the person at the keyboard is the account's owner (a borrowed
  // laptop, a stolen cookie), and a password change is precisely the move an attacker makes to keep
  // an account they have temporary access to.
  //
  // Only a LOCAL member can do this, and only while the tenant offers password sign-in: an OIDC
  // member has no credential row, and creating one here would grow them a password the tenant's SSO
  // policy never authorised (the defect the ADR's rev2 shipped and the review caught).
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>('/auth/local/password', async (req, reply) => {
      // #613 / ADR-198 §3 M8: the deployment CEILING gates the endpoint, not just the screen. Same
      // uniform not-found as the OIDC/SAML surfaces (ADR-195 §7) — a deployment that excludes `local`
      // has no password attack surface, and no probe learns the method exists. A DIFFERENT predicate
      // from the #605 stance on purpose: the stance is tenant policy and lets exemptions through; the
      // ceiling is deployment policy and admits no exceptions.
      if (!loginMethodCeiling().has('local')) return reply.code(404).send({ error: 'not found' })

    const [row] = await req.db.sql<{ password_hash: string }[]>`
      SELECT password_hash FROM local_credentials WHERE member_sub = ${req.user.sub}`
    // No credential = not a local member. 404, not 403: whether this member signs in with a password
    // is not something this route needs to confirm to whoever is asking.
    if (!row || !(await localLoginEnabled(req.db))) return reply.code(404).send({ error: 'not available' })

    const current = req.body?.currentPassword ?? ''
    const next = req.body?.newPassword ?? ''
    if (!validatePasswordPolicy(next)) {
      return reply.code(400).send({ error: `password must be at least ${PASSWORD_MIN_LENGTH} characters`, code: 'weak_password' })
    }
    // Rate-limited like the login: this is a password-guessing surface too (an attacker with a
    // borrowed session guessing the current password), and it burns a real KDF per attempt.
    const guessKey = `rl:local:change:${req.tenant.id}:${req.user.sub}`
    if (await overLimit(app.valkey, guessKey, LOCAL_LOGIN_ID_MAX)) return reply.code(429).send({ error: 'too many attempts' })
    if (!(await verifyPassword(current, row.password_hash))) {
      await countFailure(app.valkey, guessKey, LOCAL_LOGIN_WINDOW_S)
      emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'local', reason: 'invalid credentials' })
      return reply.code(403).send({ error: 'invalid credentials' })
    }
    await app.valkey.del(guessKey).catch(() => {})

    const hash = await hashPassword(next)
    // UPDATE, never INSERT: the row must already exist (checked above). An upsert here is how a
    // password gets grown on an account that never had one.
    //
    // review F1: the audit rides the SAME transaction as the update. auditIfEntitled queues through
    // the outbox precisely so a ledger line exists exactly when the change it describes committed;
    // a separate transaction with a swallowed error can leave the password changed and the ledger
    // silent, which is the state an investigation cannot recover from.
    await req.db.tx(async (tx) => {
      await tx`UPDATE local_credentials SET password_hash = ${hash}, updated_at = now() WHERE member_sub = ${req.user.sub}`
      await auditIfEntitled(tx, req.tenant, {
        actor: `user:${req.user.sub}`, action: 'member.password_changed', target: `member:${req.user.sub}`,
      })
    })
    // Every OTHER session goes: a password change is how someone evicts whoever they think is in
    // their account, and leaving the other sessions alive makes the change cosmetic.
    await destroyMemberSessions(app.valkey, req.tenant.id, req.user.sub, req.cookies?.[SESSION_COOKIE])
    emit({ type: 'member.password_changed', tenantId: req.tenant.id, targetSub: req.user.sub })
    return reply.code(204).send()
  })

  // Host-resolved tenant, no session required — this is where a session comes from.
  app.post<{ Body: { identifier?: string; password?: string; returnTo?: string } }>(
    '/auth/local/login', { config: { public: true } }, async (req, reply) => {
      // #613 / ADR-198 §3 M8: the deployment CEILING gates the endpoint, not just the screen. Same
      // uniform not-found as the OIDC/SAML surfaces (ADR-195 §7) — a deployment that excludes `local`
      // has no password attack surface, and no probe learns the method exists. A DIFFERENT predicate
      // from the #605 stance on purpose: the stance is tenant policy and lets exemptions through; the
      // ceiling is deployment policy and admits no exceptions.
      if (!loginMethodCeiling().has('local')) return reply.code(404).send({ error: 'not found' })
      const deny = () => reply.code(401).send({ error: 'invalid credentials' })
      if (!sameOriginOk(req.headers as Record<string, unknown>, req.headers.host)) {
        // Not a credential failure: nothing was checked, so nothing is counted and no event fires.
        return reply.code(403).send({ error: 'forbidden' })
      }
      const identifier = (req.body?.identifier ?? '').trim().toLowerCase()
      const password = req.body?.password ?? ''
      // review N1: the identifier is attacker-controlled and reaches a Valkey key and an event
      // payload. Bound it at the RFC's maximum address length — a longer one cannot belong to any
      // account here, so refusing it costs nothing and keeps both out of an attacker's reach.
      if (!identifier || identifier.length > MAX_IDENTIFIER_LEN || !password) return deny()

      const ip = req.ip
      const idKey = `rl:local:id:${req.tenant.id}:${identifier}`
      const ipKey = `rl:local:ip:${req.tenant.id}:${ip}`
      const lockKey = `lock:local:${req.tenant.id}:${identifier}`

      // ── C2: the lock is evaluated BEFORE anything is verified ──────────────
      const locked = await overLimit(app.valkey, lockKey, 1)
      // review B4 / ADR-198 §5: an IP over its limit is refused HERE, before the KDF. This one can
      // return early without becoming an oracle, because the answer depends only on that source's
      // own history and says nothing about any account — and it is the only thing standing between
      // an unauthenticated caller and the libuv thread pool (scrypt is ~60ms on a pool of four, so
      // roughly 65 requests a second starves fs and dns for the whole process).
      if (await overLimit(app.valkey, ipKey, LOCAL_LOGIN_IP_MAX)) {
        await countFailure(app.valkey, ipKey, LOCAL_LOGIN_WINDOW_S)
        return reply.code(429).send({ error: 'too many attempts' })
      }

      // The credential row is read even when locked, because the refusal must cost the same either
      // way (a "locked" branch that skips the KDF is the timing oracle C1 closes).
      const enabled = await localLoginEnabled(req.db)
      // #605 / ADR-210 §4 row 3: while the stance bites, only an exempt member passes — and the
      // exemption is read in the SAME query as the credential (§3: a second query that only runs when
      // the row exists is a timing oracle for "is this address an account here"). The stance itself is
      // a per-TENANT fact, computed once regardless of the identifier.
      const { resolveSsoStance } = await import('../auth/sso-stance.js')
      const stance = await resolveSsoStance(req.db, req.tenant)
      const [row] = enabled
        ? stance.biting
          ? await req.db.sql<{ member_sub: string; password_hash: string; exempt: boolean }[]>`
              SELECT lc.member_sub, lc.password_hash, (se.member_sub IS NOT NULL) AS exempt
              FROM local_credentials lc LEFT JOIN sso_exemptions se ON se.member_sub = lc.member_sub
              WHERE lc.identifier = ${identifier}`
          : await req.db.sql<{ member_sub: string; password_hash: string; exempt?: boolean }[]>`
              SELECT member_sub, password_hash FROM local_credentials WHERE identifier = ${identifier}`
        : []
      // An unknown identifier (or local login switched off) verifies against a real hash nobody holds.
      const stored = row?.password_hash ?? (await dummyHash())
      const ok = await verifyPassword(password, stored)
      // folded into the ONE failure branch below — never "you are not exempt" (§3: that would tell a
      // stranger who the exempt people are), and the KDF above has already run either way
      const stanceBlocked = stance.biting && row?.exempt !== true

      if (locked || !enabled || !row || !ok || stanceBlocked) {
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

      // Opportunistic upgrade: the only moment the plaintext is in hand (ADR-198 §4).
      if (needsRehash(stored)) {
        const fresh = await hashPassword(password)
        await req.db.sql`UPDATE local_credentials SET password_hash = ${fresh}, updated_at = now() WHERE member_sub = ${row.member_sub}`
          .catch((err: unknown) => console.error('[auth:local] re-hash failed (login still succeeds)', err))
      }

      // Membership is still the authority: `localIdentity` tells the session machinery this subject
      // is ours (skip the external-sub gate), that it must NOT auto-enrol (a password proves who you
      // are, not that you belong), and that there are no claims to overwrite the profile with.
      // review B1: establishMemberSession has refusals of its OWN — a member frozen by a plan
      // downgrade (403 member_deactivated), or one whose FGA membership is gone while the row
      // survives. Letting either escape made the response say "your password was right" to anyone
      // holding a frozen account's address: 403 for the correct password, 401 for a wrong one. It is
      // also the one branch that skipped the failure counters, so it could be probed without limit.
      // Every one of them is the same 401 as any other refusal, counted like any other refusal.
      // #652 / ADR-219 §6: does this tenant require a second factor? Asked BEFORE a session exists,
      // because §6's circle is the whole difficulty — a policy enforced only on an existing session
      // means an un-enrolled member cannot get one, cannot reach settings, and can never enrol. The
      // password was right; what comes back is a receipt saying so, not the run of the product.
      //
      // The FEDERATED doors do not pass through here at all, which is how ADR-219 §3's ruling holds
      // without a branch: this file is the product's own door and the only one the policy is about.
      if (await secondFactorRequired(req.db)) {
        const enrolled = await hasConfirmedFactor(req.db, row.member_sub)
        const fsid = await createFactorSession(app.valkey, {
          tenantId: req.tenant.id, sub: row.member_sub, enrolled,
        })
        // The counters clear here for the same reason they clear below: the password was correct, and
        // a member who mistyped twice before getting it right must not be one failure from a lock.
        await app.valkey.del(idKey).catch(() => {})
        reply.setCookie(FACTOR_COOKIE, fsid, factorCookieOptions())
        // Two different situations for the screen, not one: presenting a factor and installing one are
        // different things to be asked to do, and a single "factor required" would send somebody with
        // no authenticator to a code box they cannot fill.
        return { ok: false, factor: enrolled ? 'required' : 'enrolment-required' as const }
      }

      let sid: string
      try {
        sid = await establishMemberSession(
          { db: req.db, fga: app.fga, valkey: app.valkey, searchDriver: app.searchDriver },
          req.tenant,
          { sub: row.member_sub },
          // #655: the product's own door. `local` rather than `local+factor` — nothing asks for a factor
        // yet, and claiming one was answered would be the first lie the enforcement slice reads.
        { localIdentity: true, door: 'local' },
        )
      } catch (err) {
        // Only an AUTHORIZATION refusal becomes the uniform 401. A Valkey outage, an FGA timeout or
        // a database error is not a fact about this person's credentials, and answering "invalid
        // credentials" for one would have every member retyping a correct password while the
        // operator sees no errors at all. Those rethrow and surface as a 500, which is what they are.
        const status = (err as { statusCode?: number }).statusCode
        if (status !== 403 && status !== 402) {
          // review F3: a dependency failure is an ERROR, not an authentication event — and it is
          // logged as one so an outage is visible to whoever is on call. The trade recorded here:
          // rethrowing means that DURING an outage a correct password 500s while a wrong one still
          // 401s (the wrong one never reaches this line), which is a narrow oracle available only
          // while the product is down and not one an attacker can induce. The alternative — a 401
          // for everything — hides the outage from every member and from the logs' shape.
          req.log.error({ err, method: 'local' }, 'local login could not complete — dependency failure')
          throw err
        }
        // 402 is the seat cap — the tenant's billing, not this person's behaviour — so it is refused
        // without counting toward a lockout. Only a 403 (not a member, deactivated) is a refusal
        // about them, and only that is counted (review nit: counting everything meant a dependency
        // failure could lock a member out for half an hour during an outage).
        req.log.info({ err, method: 'local', status }, 'local login refused after a valid credential')
        if (status === 403) {
          await countFailure(app.valkey, idKey, LOCAL_LOGIN_WINDOW_S)
          await countFailure(app.valkey, ipKey, LOCAL_LOGIN_WINDOW_S)
        }
        emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'local', reason: 'invalid credentials' })
        return deny()
      }
      // Only NOW are the counters for this identifier cleared — after a session actually exists. A
      // legitimate user who mistyped twice is not one failure away from a lock, and a refusal that
      // happens after the password matched still counts (review B1).
      await app.valkey.del(idKey).catch(() => {})
      reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions())
      return { ok: true, returnTo: safeReturnTo(req.body?.returnTo) }
    },
  )

  // #652 / ADR-219 §6: present the factor, and the receipt becomes a session.
  //
  // PUBLIC, like the sign-in above — the caller has no session yet, which is the whole point. What
  // stands in for one is the factor cookie, and it is the only thing here that says who this is: the
  // request body carries a code and nothing else, so no `sub` is addressable from outside.
  app.post<{ Body: { code?: string; passkey?: unknown; returnTo?: string } }>('/auth/local/factor', { config: { public: true } }, async (req, reply) => {
    if (!sameOriginOk(req.headers as Record<string, unknown>, req.headers.host)) {
      return reply.code(403).send({ error: 'cross-origin sign-in refused' })
    }
    const fsid = req.cookies?.[FACTOR_COOKIE]
    const pending = await readFactorSession(app.valkey, fsid)
    if (!pending || pending.tenantId !== req.tenant.id) {
      // Expired, never issued, or issued for another tenant. One answer for all three: which of them
      // it was is a fact about somebody else's account.
      return reply.code(401).send({ error: 'sign in again', code: 'factor_session_expired' })
    }
    // The same limiter the password door uses, keyed the same way. Without it the code is six digits
    // behind an unlimited retry, which is a weaker door than the password it follows.
    const ipKey = `authlocal:ip:${req.ip}`
    const idKey = `authlocal:id:${pending.sub}`
    if (await overLimit(app.valkey, idKey, LOCAL_LOGIN_ID_MAX) || await overLimit(app.valkey, ipKey, LOCAL_LOGIN_IP_MAX)) {
      return reply.code(429).send({ error: 'too many attempts — try again later', code: 'locked' })
    }

    // #665: a passkey answers the same question a code does, so it arrives at the same door. The
    // session's `door` stays `local+factor` either way — WHICH kind of factor was presented is a fact
    // about the row, not about the entrance, and adding a value would grow both #655's table and #652's
    // decision for nothing.
    if (req.body?.passkey) {
      const proved = await verifyPasskeyAssertion(
        { db: req.db, valkey: app.valkey },
        { memberSub: pending.sub, host: req.headers.host, receiptSid: fsid!, response: req.body.passkey as never },
      )
      if (!proved) {
        await countFailure(app.valkey, idKey, LOCAL_LOGIN_WINDOW_S)
        await countFailure(app.valkey, ipKey, LOCAL_LOGIN_WINDOW_S)
        emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'local', reason: 'invalid credentials' })
        return reply.code(401).send({ error: 'that key did not work', code: 'passkey_invalid' })
      }
      const sid = await establishMemberSession(
        { db: req.db, fga: app.fga, valkey: app.valkey, searchDriver: app.searchDriver },
        req.tenant, { sub: pending.sub }, { localIdentity: true, door: 'local+factor' },
      )
      await destroyFactorSession(app.valkey, fsid)
      reply.clearCookie(FACTOR_COOKIE, { path: '/api' })
      await app.valkey.del(idKey).catch(() => {})
      await markFactorUsed(req.db, proved.factorId)
      reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions())
      emit({ type: 'auth.success', tenantId: req.tenant.id, actorId: pending.sub, method: 'local' })
      return { ok: true, returnTo: safeReturnTo(req.body?.returnTo) }
    }

    const code = typeof req.body?.code === 'string' ? req.body.code : ''
    // #675: the same condition the floor and the sweep ask, so "this counts" cannot mean two things.
    // The host half is a no-op for a TOTP and is asked anyway — the day a third kind arrives, a query
    // that spelled the rule itself is the one that keeps the old answer.
    const rows = await req.db.sql<{ id: string }[]>`
      SELECT f.id FROM member_factors f
      WHERE f.member_sub = ${pending.sub} AND f.kind = 'totp' AND ${presentableHere(req.db, req.headers.host)}`
    let matched: { id: string; counter: number } | null = null
    for (const r of rows) {
      const secret = await totpSecretFor(req.db, r.id)
      const counter = secret ? verifyTotp(secret, code, Date.now()) : null
      // EVERY factor is tried, not just until one matches: somebody who holds a phone and a spare key
      // presents whichever they have to hand, and stopping early would make which one they used
      // observable in the response time.
      if (counter !== null && !matched) matched = { id: r.id, counter }
    }
    if (!matched) {
      await countFailure(app.valkey, idKey, LOCAL_LOGIN_WINDOW_S)
      await countFailure(app.valkey, ipKey, LOCAL_LOGIN_WINDOW_S)
      emit({ type: 'auth.failed', tenantId: req.tenant.id, method: 'local', reason: 'invalid credentials' })
      return reply.code(401).send({ error: 'that code did not match', code: 'factor_code_invalid' })
    }
    // Spend the step BEFORE the session exists. A code is live for its whole window, so without this
    // the same six digits — shoulder-surfed, or read off a screen share — open a second session
    // within the minute.
    if (!(await spendTotpCounter(req.db, matched.id, matched.counter))) {
      await countFailure(app.valkey, idKey, LOCAL_LOGIN_WINDOW_S)
      return reply.code(401).send({ error: 'that code has already been used', code: 'factor_code_replayed' })
    }

    const sid = await establishMemberSession(
      { db: req.db, fga: app.fga, valkey: app.valkey, searchDriver: app.searchDriver },
      req.tenant,
      { sub: pending.sub },
      // …and NOW the door is `local+factor`. It was `local` at the password step and stayed there
      // because nothing had been answered yet — claiming otherwise would have been the lie the
      // enforcement reads.
      { localIdentity: true, door: 'local+factor' },
    )
    await destroyFactorSession(app.valkey, fsid)
    reply.clearCookie(FACTOR_COOKIE, { path: '/api' })
    await app.valkey.del(idKey).catch(() => {})
    await markFactorUsed(req.db, matched.id)
    reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions())
    emit({ type: 'auth.success', tenantId: req.tenant.id, actorId: pending.sub, method: 'local' })
    return { ok: true, returnTo: safeReturnTo(req.body?.returnTo) }
  })

  /**
   * The options for a passkey assertion, for somebody holding a receipt (#665).
   *
   * A GET-shaped question answered by POST because it WRITES: issuing options banks a challenge, and a
   * challenge minted by a cacheable GET is one a proxy can hand to the next caller.
   */
  app.post('/auth/local/factor/passkey/options', { config: { public: true } }, async (req, reply) => {
    const held = await receipt(req as never)
    if (!held) return reply.code(401).send({ error: 'sign in again', code: 'factor_session_expired' })
    const options = await passkeyAuthenticationOptions(
      { db: req.db, valkey: app.valkey },
      { memberSub: held.pending.sub, host: req.headers.host, receiptSid: held.sid! },
    )
    return reply.code(200).send({ options })
  })

  // ── enrolling FROM the interstitial (ADR-219 §6's circle) ───────────────────────────────────────
  //
  // Policy on → an un-enrolled member gets no session → cannot reach /settings → can never enrol. The
  // way out is two routes that take the factor receipt instead of a session.
  //
  // They live HERE, next to the door, rather than by loosening the session guard so that `/me/factors`
  // accepts a half-credential. That guard's value is that it has one input: a route which sometimes
  // accepts a session and sometimes a receipt is a route whose principal depends on which cookie the
  // caller sent, and every later reader has to know that. The logic is not duplicated — both call the
  // same store functions the settings screen does.
  const receipt = async (req: { cookies?: Record<string, string>; tenant: { id: string } }) => {
    const sid = req.cookies?.[FACTOR_COOKIE]
    const pending = await readFactorSession(app.valkey, sid)
    return pending && pending.tenantId === req.tenant.id ? { sid, pending } : null
  }

  app.post('/auth/local/factor/enrol', { config: { public: true } }, async (req, reply) => {
    const held = await receipt(req as never)
    if (!held) return reply.code(401).send({ error: 'sign in again', code: 'factor_session_expired' })
    // Only somebody who has NOTHING enrolled may take this door. A member who holds a factor and wants
    // another one has a session to do it from, and letting them through here would turn "I know a
    // password" into "I can add an authenticator" — which is the re-authentication ADR-219 §8 asks for,
    // skipped.
    if (held.pending.enrolled) {
      return reply.code(409).send({ error: 'present your existing factor first', code: 'factor_required' })
    }
    const secret = generateTotpSecret()
    const { factorId } = await startTotpEnrolment(req.db, {
      tenantId: req.tenant.id, memberSub: held.pending.sub, secret,
    })
    const [row] = await req.db.sql<[{ email: string | null }?]>`
      SELECT email FROM members WHERE sub = ${held.pending.sub}`
    return reply.code(201).send({
      factorId, secret,
      uri: totpUri({ secret, account: row?.email || held.pending.sub, issuer: productName() }),
    })
  })

  app.post<{ Params: { id: string }; Body: { code?: string; returnTo?: string } }>(
    '/auth/local/factor/enrol/:id/confirm',
    { config: { public: true } },
    async (req, reply) => {
      const held = await receipt(req as never)
      if (!held) return reply.code(401).send({ error: 'sign in again', code: 'factor_session_expired' })
      const idKey = `authlocal:id:${held.pending.sub}`
      if (await overLimit(app.valkey, idKey, LOCAL_LOGIN_ID_MAX)) {
        return reply.code(429).send({ error: 'too many attempts — try again later', code: 'locked' })
      }
      // `kind = 'totp'`, for the reason #666 records: a route that does not ask which proof a factor
      // takes reports the mismatch as the member's mistake ("that code did not match" about a thing
      // with no code). This door only ever mints TOTP enrolments, so the filter is belt to that brace.
      const [own] = await req.db.sql<[{ id: string }?]>`
        SELECT id FROM member_factors
        WHERE id = ${req.params.id} AND member_sub = ${held.pending.sub} AND kind = 'totp' AND confirmed_at IS NULL`
      if (!own) return reply.code(404).send({ error: 'no pending enrolment', code: 'factor_not_pending' })

      const secret = await totpSecretFor(req.db, req.params.id)
      const counter = secret ? verifyTotp(secret, typeof req.body?.code === 'string' ? req.body.code : '', Date.now()) : null
      if (counter === null) {
        await countFailure(app.valkey, idKey, LOCAL_LOGIN_WINDOW_S)
        return reply.code(400).send({ error: 'that code did not match', code: 'factor_code_invalid' })
      }
      await spendTotpCounter(req.db, req.params.id, counter)
      if (!(await confirmFactor(req.db, req.params.id))) {
        return reply.code(409).send({ error: 'this enrolment is no longer pending', code: 'factor_not_pending' })
      }
      await req.db.tx(async (tx) => auditIfEntitled(tx, req.tenant, {
        actor: `user:${held.pending.sub}`, action: 'member.factor_enrolled', target: `member:${held.pending.sub}`,
      })).catch((err: unknown) => req.log.warn({ err }, 'factor enrolment audit failed'))
      emit({ type: 'member.factor_enrolled', tenantId: req.tenant.id, actorId: held.pending.sub, targetSub: held.pending.sub })

      // Enrolling IS answering: they produced a code from the thing they just registered, in front of
      // us. Making them sign in again would be asking for the same proof twice.
      const sid = await establishMemberSession(
        { db: req.db, fga: app.fga, valkey: app.valkey, searchDriver: app.searchDriver },
        req.tenant, { sub: held.pending.sub }, { localIdentity: true, door: 'local+factor' },
      )
      await destroyFactorSession(app.valkey, held.sid)
      reply.clearCookie(FACTOR_COOKIE, { path: '/api' })
      await app.valkey.del(idKey).catch(() => {})
      reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions())
      return { ok: true, returnTo: safeReturnTo(req.body?.returnTo) }
    },
  )
}

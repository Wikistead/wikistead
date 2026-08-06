import type { FastifyInstance } from 'fastify'
import type IORedis from 'ioredis'
import { emit } from '@wikistead/events'
import { auditIfEntitled } from '../audit/outbox.js'
import {
  startTotpEnrolment, totpSecretFor, confirmFactor, listFactors, markFactorUsed, deleteFactor,
  discardPendingFactors, startPasskeyEnrolment, type FactorKind,
} from '../auth/second-factors.js'
import type { TenantDb } from '../db/index.js'
import { generateTotpSecret, totpUri, verifyTotp } from '../auth/totp.js'
import { spendTotpCounter } from '../auth/second-factors.js'
import { secondFactorRequired, wouldStrandTenant, secondFactorStance, acceptedKinds } from '../auth/factor-policy.js' // #652: the floor, #677: the kinds
import { passkeyRegistrationOptions, verifyPasskeyRegistration, storePasskey } from '../auth/passkeys.js' // #663
import { passkeyRemovalOptions, verifyPasskeyForRemoval } from '../auth/passkeys.js' // #666

/** The assertion arrives as a query string, so a malformed one is an answer rather than a 500. */
function parseAssertion(raw: unknown): unknown {
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) } catch { return null }
}
import { productName } from '../product-name.js'

// Enrolling a second factor (#657 / ADR-219 §7). SELF-SCOPE, like the rest of /me: every read and
// write is keyed to `req.user.sub`, never to a parameter. Guests have no member row and never reach
// here — the default guard requires `req.user`.
//
// NOT here, deliberately:
//   - The tenant POLICY and its enforcement (#652). Nothing in this file asks whether a factor is
//     required; it only lets somebody get one.
//
// REMOVING a factor is here as of #660, with ADR-219 §8's re-authentication taking the form of a code
// FROM THE FACTOR BEING REMOVED. Re-authenticating with a password would only work for members who have
// one, so removal would exist for some doors and not others — the shape #613 and #605 both had to undo.
// Possession of the thing being given up is the same proof for everybody, it is what a stolen session
// cannot supply, and it leaves the lost-phone case where the design already put it: an administrator
// reset (#644).
//
// #652 slice 2 ADDED the floor this file used to describe as unwritable: while the tenant policy is on,
// the LAST admin holding a factor may not remove it (ADR-219 §4 — the outbound half of #605's two-sided
// guard, without which the switch's own precondition dies one delete later). It genuinely could not be
// written before the policy column existed: with nothing to turn on, the guard's counterfactual was
// unreachable and its pin would have passed because the case could not occur.
//
// WHO MAY ENROL: anybody with a member row, including a member who signs in through the IdP today.
// ADR-219 §3 says a federated door is never asked for a product-side factor, which is a fact about
// DOORS, not about accounts — and #626/migration 109 lets an admin give any member a password
// entrance later, so a member who is federated-only this morning may have a product-side door this
// afternoon. Refusing enrolment on today's doors would be a refusal that becomes wrong without
// anybody changing this file.

const num = (env: string | undefined, fallback: number) => {
  const n = Number(env)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// The SHAPE of `auth-local.ts:36-39` — 5 attempts per identity in a 15-minute window, then a lock
// that expires on its own — under its OWN names.
//
// Not an import. `LOCAL_LOGIN_ID_MAX` is read from `process.env.LOCAL_LOGIN_ID_MAX`, so importing it
// would make a deployment's LOGIN attempt budget silently govern how many times a factor code may be
// tried. They are different questions with different right answers, and the coupling would be
// invisible: nothing at either call site mentions the other.
/**
 * How many factors one member may hold.
 *
 * A cap rather than a page. #623's ledger caught `GET /me/factors` as a list with no bound, and the two
 * ways to answer that are not equivalent here: paging a list of authenticators would mean a member
 * could hold more than they can see, which is the fail-open the ledger exists to prevent — somebody
 * removing "all my factors" would leave the ones on page two. Ten is a phone, a laptop and several
 * keys; the enrolment is refused past it, so the list is bounded by construction rather than truncated.
 */
export const MAX_FACTORS_PER_MEMBER = num(process.env.MAX_FACTORS_PER_MEMBER, 10)

export const FACTOR_VERIFY_MAX = num(process.env.FACTOR_VERIFY_MAX, 5)
export const FACTOR_VERIFY_WINDOW_S = num(process.env.FACTOR_VERIFY_WINDOW_S, 15 * 60)
export const FACTOR_VERIFY_LOCK_S = num(process.env.FACTOR_VERIFY_LOCK_S, 30 * 60)

const attemptKey = (tenantId: string, sub: string) => `factor:try:${tenantId}:${sub}`
const lockKey = (tenantId: string, sub: string) => `factor:lock:${tenantId}:${sub}`

/**
 * Read the lock without touching it. FAILS CLOSED on a Valkey error, like the login limiter: a
 * limiter that disappears under load is not a limiter. It says so in the log rather than pretending
 * the member is locked out for a reason they could act on.
 */
async function locked(valkey: IORedis, tenantId: string, sub: string): Promise<boolean> {
  try {
    return (await valkey.get(lockKey(tenantId, sub))) !== null
  } catch (err) {
    console.error('[factor] lock unreadable — refusing (fail closed)', err)
    return true
  }
}

/** Count a failure, and lock once the window's budget is gone. */
async function countFailure(valkey: IORedis, tenantId: string, sub: string): Promise<void> {
  try {
    const n = await valkey.incr(attemptKey(tenantId, sub))
    if (n === 1) await valkey.expire(attemptKey(tenantId, sub), FACTOR_VERIFY_WINDOW_S)
    if (n >= FACTOR_VERIFY_MAX) await valkey.set(lockKey(tenantId, sub), '1', 'EX', FACTOR_VERIFY_LOCK_S)
  } catch (err) {
    console.error('[factor] counter unwritable — a failure went uncounted', err)
  }
}

/** Forget the failures. A success is the end of that window, not a smaller number in it. */
async function clearFailures(valkey: IORedis, tenantId: string, sub: string): Promise<void> {
  try {
    await valkey.del(attemptKey(tenantId, sub), lockKey(tenantId, sub))
  } catch { /* a stale counter costs the member a wait, never access */ }
}

export async function secondFactorPlugin(app: FastifyInstance) {
  /** The member's own factors. Never carries a secret — the list is for naming and removing. */
  app.get('/me/factors', async (req) => ({ factors: await listFactors(req.db, req.user.sub) }))

  /**
   * Begin a TOTP enrolment. Returns the secret ONCE, in the response that created it: the phone has
   * to be given it, and this product does not keep a way to show it again (`totpSecretFor` is server
   * side and never leaves it). Somebody who loses the phone between start and confirm starts again.
   *
   * Starting does not enrol anything. The row is unconfirmed, so no policy counts it and the member's
   * own list does not show it — an abandoned start is invisible rather than a half-factor.
   */
  /**
   * #677 / ADR-222 §5: enrolling a kind the tenant does not accept is refused HERE, not hidden on the
   * screen. #613 is the lesson — the sign-in form was hidden while the POST kept authenticating.
   *
   * `off` accepts everything (ADR-222 §1). Reading it as "accepts nothing" would close both doors, and
   * then the floor could never be met and the stance could never be turned on again.
   */
  const kindRefusal = async (db: TenantDb, kind: FactorKind) => {
    const accepted = acceptedKinds(await secondFactorStance(db))
    return accepted.includes(kind)
      ? null
      : {
          statusCode: 409,
          body: {
            error: kind === 'passkey'
              ? 'this workspace asks for an authenticator app, not a passkey'
              : 'this workspace asks for a passkey, not an authenticator app',
            code: 'factor_kind_not_accepted',
          },
        }
  }

  app.post<{ Body: { label?: string } }>('/me/factors/totp', async (req, reply) => {
    const refused = await kindRefusal(req.db, 'totp')
    if (refused) return reply.code(refused.statusCode).send(refused.body)
    // First, throw away this member's own abandoned starts. Leaving them was how three closed tabs
    // became an account that could never enrol again: the cap counts pending rows, so they accumulated
    // silently until the eighth real enrolment was refused.
    await discardPendingFactors(req.db, req.user.sub)
    // Counting PENDING rows too: otherwise starting enrolments without confirming them is an unbounded
    // write, and the cap would only bound what the member can see rather than what they can create.
    const [held] = await req.db.sql<[{ n: number }?]>`
      SELECT count(*)::int AS n FROM member_factors WHERE member_sub = ${req.user.sub}`
    if ((held?.n ?? 0) >= MAX_FACTORS_PER_MEMBER) {
      return reply.code(409).send({
        error: `you already have ${MAX_FACTORS_PER_MEMBER} — remove one before adding another`,
        code: 'factor_limit_reached',
      })
    }
    const secret = generateTotpSecret()
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 100) : ''
    const { factorId } = await startTotpEnrolment(req.db, {
      tenantId: req.tenant.id, memberSub: req.user.sub, secret, label,
    })
    // The account name in the app's list. The email is what the reader recognises; the sub is what is
    // unique, and is used when there is no address to show.
    const [row] = await req.db.sql<[{ email: string | null }?]>`
      SELECT email FROM members WHERE sub = ${req.user.sub}`
    const uri = totpUri({ secret, account: row?.email || req.user.sub, issuer: productName() })
    return reply.code(201).send({ factorId, secret, uri })
  })

  /**
   * Confirm it, by proving a code can be produced from the secret.
   *
   * This is the ONE place the enrolment becomes real. Without it, "enrolled" would mean "was shown a
   * QR code", and a policy counting those would lock out everybody who scanned nothing.
   */
  app.post<{ Params: { id: string }; Body: { code?: string } }>('/me/factors/:id/confirm', async (req, reply) => {
    const { id } = req.params
    if (await locked(app.valkey, req.tenant.id, req.user.sub)) {
      return reply.code(429).send({ error: 'too many attempts — try again later', code: 'factor_locked' })
    }
    // The factor must be THIS member's. An id is a bearer token for a row otherwise, and confirming
    // somebody else's enrolment would hand them a factor they never proved.
    // `kind = 'totp'` for the reason #666 found the hard way: without it a PASSKEY enrolment reaches
    // this route, `totpSecretFor` answers null, and the member is told "that code did not match" about
    // a factor that has no code. Which proof a factor takes is a fact about the factor; a route that
    // does not ask reports the mismatch as the member's mistake.
    const [own] = await req.db.sql<[{ id: string }?]>`
      SELECT id FROM member_factors
      WHERE id = ${id} AND member_sub = ${req.user.sub} AND kind = 'totp' AND confirmed_at IS NULL`
    // One answer for two cases a caller may not distinguish: no such factor, and not yours. Saying
    // which would make this an oracle for whether an id exists.
    if (!own) return reply.code(404).send({ error: 'no pending enrolment', code: 'factor_not_pending' })

    const secret = await totpSecretFor(req.db, id)
    const code = typeof req.body?.code === 'string' ? req.body.code : ''
    const counter = secret ? verifyTotp(secret, code, Date.now()) : null
    if (counter === null) {
      await countFailure(app.valkey, req.tenant.id, req.user.sub)
      return reply.code(400).send({ error: 'that code did not match', code: 'factor_code_invalid' })
    }
    // Bank the step. Not primarily a replay refusal HERE — confirmation is one-shot, so the same code
    // cannot be presented to this factor twice — but the floor #652 starts from: a code spent to
    // confirm an enrolment must not then sign the same person in, inside the same window, as if it
    // were fresh. Verification asked more than once is what makes the refusal reachable, and that is
    // #652's slice; this route's job is to leave the counter behind.
    if (!(await spendTotpCounter(req.db, id, counter))) {
      await countFailure(app.valkey, req.tenant.id, req.user.sub)
      return reply.code(400).send({ error: 'that code has already been used', code: 'factor_code_replayed' })
    }
    if (!(await confirmFactor(req.db, id))) {
      return reply.code(409).send({ error: 'this enrolment is no longer pending', code: 'factor_not_pending' })
    }
    await clearFailures(app.valkey, req.tenant.id, req.user.sub)
    await markFactorUsed(req.db, id)
    // ADR-219's acceptance: ENROLMENT is audited, not only removal. A ledger that records the taking
    // away cannot answer "when did this account get its factor", which is the question asked when an
    // account turns out to have been reachable by somebody else.
    await req.db.tx(async (tx) => auditIfEntitled(tx, req.tenant, {
      actor: `user:${req.user.sub}`, action: 'member.factor_enrolled', target: `member:${req.user.sub}`,
    })).catch((err: unknown) => req.log.warn({ err }, 'factor enrolment audit failed'))
    // #228's policy: a new feature brings its webhook with it. Something changed about who can
    // authenticate this account, which is the same reason `member.password_enabled` is emitted.
    emit({ type: 'member.factor_enrolled', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.user.sub })
    return reply.code(200).send({ confirmed: true })
  })

  /**
   * Begin a passkey enrolment (#663 / ADR-219 §1).
   *
   * Same shape as the TOTP start above and for the same reasons: the cap is checked first, abandoned
   * rows are cleared, and the factor row exists UNCONFIRMED until the browser comes back with a
   * credential. What differs is that the secret never leaves the authenticator — there is nothing here
   * to show once, which is why this returns options rather than a key.
   */
  app.post<{ Body: { label?: string } }>('/me/factors/passkey', async (req, reply) => {
    const refused = await kindRefusal(req.db, 'passkey')
    if (refused) return reply.code(refused.statusCode).send(refused.body)
    await discardPendingFactors(req.db, req.user.sub)
    const [held] = await req.db.sql<[{ n: number }?]>`
      SELECT count(*)::int AS n FROM member_factors WHERE member_sub = ${req.user.sub}`
    if ((held?.n ?? 0) >= MAX_FACTORS_PER_MEMBER) {
      return reply.code(409).send({
        error: `you already have ${MAX_FACTORS_PER_MEMBER} — remove one before adding another`,
        code: 'factor_limit_reached',
      })
    }
    const [row] = await req.db.sql<[{ email: string | null }?]>`
      SELECT email FROM members WHERE sub = ${req.user.sub}`
    const options = await passkeyRegistrationOptions(
      { db: req.db, valkey: app.valkey },
      { tenantId: req.tenant.id, memberSub: req.user.sub, memberName: row?.email || req.user.sub, host: req.headers.host },
    )
    const { factorId } = await startPasskeyEnrolment(req.db, {
      tenantId: req.tenant.id, memberSub: req.user.sub,
      label: typeof req.body?.label === 'string' ? req.body.label.slice(0, 100) : '',
    })
    return reply.code(201).send({ factorId, options })
  })

  /** Finish it: the browser's credential, checked, stored, and the factor confirmed. */
  app.post<{ Params: { id: string }; Body: { response?: unknown } }>('/me/factors/:id/passkey', async (req, reply) => {
    const { id } = req.params
    if (await locked(app.valkey, req.tenant.id, req.user.sub)) {
      return reply.code(429).send({ error: 'too many attempts — try again later', code: 'factor_locked' })
    }
    const [own] = await req.db.sql<[{ id: string }?]>`
      SELECT id FROM member_factors
      WHERE id = ${id} AND member_sub = ${req.user.sub} AND kind = 'passkey' AND confirmed_at IS NULL`
    if (!own) return reply.code(404).send({ error: 'no pending enrolment', code: 'factor_not_pending' })

    const verified = await verifyPasskeyRegistration(
      { valkey: app.valkey },
      { tenantId: req.tenant.id, memberSub: req.user.sub, host: req.headers.host, response: req.body?.response as never },
    )
    if (!verified) {
      await countFailure(app.valkey, req.tenant.id, req.user.sub)
      return reply.code(400).send({ error: 'that key could not be registered', code: 'passkey_invalid' })
    }
    await storePasskey(req.db, { tenantId: req.tenant.id, factorId: id, passkey: verified })
    if (!(await confirmFactor(req.db, id))) {
      return reply.code(409).send({ error: 'this enrolment is no longer pending', code: 'factor_not_pending' })
    }
    await clearFailures(app.valkey, req.tenant.id, req.user.sub)
    await markFactorUsed(req.db, id)
    // The same event a TOTP enrolment writes: what the ledger records is that this account gained a
    // factor, and which kind it was belongs to the row rather than to the verb.
    await req.db.tx(async (tx) => auditIfEntitled(tx, req.tenant, {
      actor: `user:${req.user.sub}`, action: 'member.factor_enrolled', target: `member:${req.user.sub}`,
    })).catch((err: unknown) => req.log.warn({ err }, 'factor enrolment audit failed'))
    emit({ type: 'member.factor_enrolled', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.user.sub })
    return reply.code(200).send({ confirmed: true })
  })

  /**
   * The challenge for giving up a PASSKEY (#666).
   *
   * A POST because it WRITES — issuing options banks a challenge, and one minted by a cacheable GET is
   * one a proxy can hand to the next caller.
   */
  app.post<{ Params: { id: string } }>('/me/factors/:id/remove-challenge', async (req, reply) => {
    const [own] = await req.db.sql<[{ kind: string; confirmed_at: Date | null }?]>`
      SELECT kind, confirmed_at FROM member_factors WHERE id = ${req.params.id} AND member_sub = ${req.user.sub}`
    // Not yours and not existing answer the same, for the reason the delete below gives.
    if (!own) return reply.code(404).send({ error: 'no such factor', code: 'factor_not_found' })
    // A TOTP factor has no assertion to give. Answering 400 rather than issuing a useless challenge
    // keeps "which proof does this factor take" a fact about the factor rather than a guess.
    if (own.kind !== 'passkey' || !own.confirmed_at) {
      return reply.code(400).send({ error: 'this factor is not removed with a key', code: 'factor_wrong_proof' })
    }
    const options = await passkeyRemovalOptions(
      { db: req.db, valkey: app.valkey },
      { tenantId: req.tenant.id, memberSub: req.user.sub, factorId: req.params.id, host: req.headers.host },
    )
    if (!options) return reply.code(404).send({ error: 'no such factor', code: 'factor_not_found' })
    return reply.code(200).send({ options })
  })

  /**
   * Give one up. #660 — the operation #626 named as the one that must exist beside adding.
   *
   * A CONFIRMED factor needs a current code from it (see the header). A PENDING one does not: it guards
   * nothing yet, and demanding possession there would make an abandoned enrolment permanent — the
   * member would hold a row they cannot use and cannot clear, which is a worse version of the problem
   * this route exists to fix.
   */
  /**
   * Rename one. #653④: the label could be set at enrolment and never again, so a phone that was
   * "iPhone" stayed "iPhone" after it became the old one — and with several authenticators the list is
   * only useful if the names can be corrected.
   *
   * NO possession proof, deliberately. #660 asks for a current code before REMOVAL because removal
   * takes a door away; a label touches no secret and grants nothing, and demanding the device to fix a
   * typo would push people to keep the wrong name. The line: possession guards what a factor CAN DO,
   * not what it is called.
   *
   * Unconfirmed rows may be renamed too — they are shown (①), so they can be acted on.
   */
  app.patch<{ Params: { id: string }; Body: { label?: string } }>('/me/factors/:id', async (req, reply) => {
    if (typeof req.body?.label !== 'string') {
      return reply.code(400).send({ error: 'label is required', code: 'factor_label_required' })
    }
    // Same slice as enrolment (`:133`), so a name cannot arrive here that could not have been set there.
    const label = req.body.label.slice(0, 100)
    // Scoped to the caller, and the same single answer as DELETE for "no such factor" and "not yours".
    const [own] = await req.db.sql<[{ id: string }?]>`
      UPDATE member_factors SET label = ${label}
      WHERE id = ${req.params.id} AND member_sub = ${req.user.sub} RETURNING id`
    if (!own) return reply.code(404).send({ error: 'no such factor', code: 'factor_not_found' })

    // NOT audited, and that is a decision rather than an omission. ADR-219 §7's ledger answers "when did
    // this account gain or lose a way in"; renaming changes neither. Recording it would put noise
    // between the entries that do — the same reason an abandoned enrolment's tidy-up is not recorded
    // just below.
    return reply.code(204).send()
  })

  app.delete<{ Params: { id: string }; Querystring: { code?: string; passkey?: string } }>('/me/factors/:id', async (req, reply) => {
    const { id } = req.params
    if (await locked(app.valkey, req.tenant.id, req.user.sub)) {
      return reply.code(429).send({ error: 'too many attempts — try again later', code: 'factor_locked' })
    }
    // Scoped to the caller, and one answer for "no such factor" and "not yours": distinguishing them
    // would make this an oracle for which ids exist.
    const [own] = await req.db.sql<[{ id: string; kind: string; confirmed_at: Date | null }?]>`
      SELECT id, kind, confirmed_at FROM member_factors WHERE id = ${id} AND member_sub = ${req.user.sub}`
    if (!own) return reply.code(404).send({ error: 'no such factor', code: 'factor_not_found' })

    if (own.confirmed_at && await secondFactorRequired(req.db)
        && await wouldStrandTenant(req.db, { memberSub: req.user.sub, factorId: id, host: req.headers.host })) {
      // The floor. Refused with a reason, and the reason names the two ways out — because a member who
      // is told only "no" will try again rather than enrol a second one or turn the policy off.
      return reply.code(409).send({
        error: 'you are the last admin who can sign in under this tenant\'s second-factor requirement — enrol another authenticator, or turn the requirement off, before removing this one',
        code: 'last_admin_factor',
      })
    }

    if (own.confirmed_at) {
      // #666: the proof is the FACTOR'S OWN. `totpSecretFor` answers null for a passkey, so asking for
      // a code refused every one of them unconditionally — registered and permanent. And a TOTP code
      // must not remove a passkey either way: somebody who took one factor would be able to strip the
      // other, and holding two would stop meaning anything.
      const proved = own.kind === 'passkey'
        ? await verifyPasskeyForRemoval(
            { db: req.db, valkey: app.valkey },
            { tenantId: req.tenant.id, memberSub: req.user.sub, factorId: id, host: req.headers.host,
              response: parseAssertion(req.query?.passkey) as never },
          )
        : await (async () => {
            const secret = await totpSecretFor(req.db, id)
            const code = typeof req.query?.code === 'string' ? req.query.code : ''
            return secret !== null && verifyTotp(secret, code, Date.now()) !== null
          })()
      if (!proved) {
        await countFailure(app.valkey, req.tenant.id, req.user.sub)
        return reply.code(400).send(own.kind === 'passkey'
          ? { error: 'use this key to confirm removing it', code: 'passkey_invalid' }
          : { error: 'enter a current code from this authenticator to remove it', code: 'factor_code_invalid' })
      }
    }

    if (!(await deleteFactor(req.db, req.user.sub, id))) {
      return reply.code(404).send({ error: 'no such factor', code: 'factor_not_found' })
    }
    await clearFailures(app.valkey, req.tenant.id, req.user.sub)
    // Only a CONFIRMED factor is a thing the ledger cares about losing. An abandoned enrolment being
    // tidied away is not an event in the account's security history, and recording it would put noise
    // between the entries that matter.
    if (own.confirmed_at) {
      await req.db.tx(async (tx) => auditIfEntitled(tx, req.tenant, {
        actor: `user:${req.user.sub}`, action: 'member.factor_removed', target: `member:${req.user.sub}`,
      })).catch((err: unknown) => req.log.warn({ err }, 'factor removal audit failed'))
      emit({ type: 'member.factor_removed', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.user.sub })
    }
    return reply.code(204).send()
  })
}

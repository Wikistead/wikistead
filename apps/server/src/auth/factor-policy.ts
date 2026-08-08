// What the second-factor policy admits (#652 slice 1 / ADR-219 §2 §3 §4).
//
// A pure decision, deliberately separated from everything that will call it. The wiring, the tenant
// switch and the interstitial are the rest of #652 — the switch is still with the ruling (#644), and
// the interstitial is unreachable without enforcement, so it belongs in the same commit as the wiring
// rather than this one.
//
// This is the piece worth pinning on its own, because it is the piece most likely to be implemented
// backwards. ADR-219 §2 says a session with no recorded door reads as unsatisfied; §3 rules that
// federated sign-ins are out of the policy's scope entirely. Read one after the other and the obvious
// implementation is "no factor recorded → ask for one", which sends every OIDC member to an
// interstitial and reverses §3 without anybody editing it. The table below is the ruling; a caller can
// now be wrong about how to call this, but not about what it decides.
import type { TenantDb } from '../db/index.js'
import { doorOf, type SessionData, type SessionDoor } from './session.js'
import { rpIdFromHost } from './passkeys.js' // #672: a passkey answers only at the host it was made on
import type { FactorKind } from './second-factors.js'

/** What a request may do about a session, once the policy is on. */
export type FactorVerdict =
  /** proceed: either the policy is off, or this door is not the policy's business, or it was answered */
  | 'admit'
  /** the member must enrol or present a factor before going further (ADR-219 §6's interstitial) */
  | 'require-factor'

export type PolicyInput = {
  /** whether THIS tenant requires a second factor. Where that comes from is the rest of #652. */
  policyOn: boolean
  door: SessionDoor
}

/**
 * The table, in one place.
 *
 *   policy off        → admit, whatever the door. A policy nobody turned on decides nothing.
 *   local+factor      → admit. The factor was answered at the door.
 *   federated         → admit. ADR-219 §3: the product cannot verify what the IdP asked, and asking
 *                       anyway would be a second factor demanded in ignorance of the first. NOT a
 *                       "close enough" — it is the ruling, and the case this file exists to protect.
 *   operator          → admit. ADR-219 §4: the break-glass path crosses requirements on purpose. It
 *                       already crosses the SSO stance; a self-hoster who has lost every authenticator
 *                       would otherwise lose the tenant.
 *   local             → require-factor. The one door the policy is about.
 *   (absent)          → `doorOf` reads it as `local`, so: require-factor. Grandfathering an old cookie
 *                       would make "hold one from last week" the way around a rule introduced this
 *                       week — a bypass, not a migration.
 */
export function factorVerdict({ policyOn, door }: PolicyInput): FactorVerdict {
  if (!policyOn) return 'admit'
  switch (door) {
    case 'local+factor':
    case 'federated':
    case 'operator':
      return 'admit'
    case 'local':
      return 'require-factor'
  }
}

/** The same question asked of a session, so no caller has to remember to go through `doorOf`. */
export const sessionVerdict = (s: Pick<SessionData, 'door'>, policyOn: boolean): FactorVerdict =>
  factorVerdict({ policyOn, door: doorOf(s) })

/**
 * The principals the policy does NOT cover (ADR-219 §5), named rather than left to the wiring.
 *
 * Four of the five ways a member principal is created never touch a session (`app.ts`: dev-token, the
 * MCP OAuth provider, an API key, an OIDC bearer), so a check written as "look at the session" simply
 * does not run for them — which reads as an exemption nobody decided. It IS an exemption, and it is
 * this one: a key or a bearer is a credential the member already proved themselves to create, and
 * issuing one re-authenticates (§8). Guests are out of scope entirely — anonymous editing through a
 * share link is the core of this product and there is no subject to attach a factor to.
 *
 * Exported so the wiring slice can assert against it instead of restating it.
 */
export const PRINCIPALS_OUTSIDE_POLICY = ['api-key', 'oidc-bearer', 'mcp-oauth', 'dev-token', 'guest'] as const

// ── the tenant's stance, and who may set it (#652 slice 2) ───────────────────────────────────────

/**
 * Whether THIS tenant requires a second factor. Migration 118, beside the other stances.
 *
 * A tenant with no `tenant_login_prefs` row has never decided anything, which is not the same as
 * deciding "no" — but it produces the same answer, and the alternative (treating an absent row as a
 * requirement) would lock out every tenant that predates the column.
 */
export async function secondFactorRequired(db: TenantDb): Promise<boolean> {
  return (await secondFactorStance(db)) !== 'off'
}

/**
 * WHICH kinds this tenant accepts (#676 / ADR-222 §1). Migration 120.
 *
 * `off` is not the empty set — see the migration. It means the tenant asks for nothing, so both
 * enrolment doors stay open, the floor is not consulted, and the sweep does not run.
 */
export type FactorStance = 'off' | 'any' | 'passkey' | 'totp'

export async function secondFactorStance(db: TenantDb): Promise<FactorStance> {
  const [row] = await db.sql<[{ second_factor_kinds: string }?]>`
    SELECT second_factor_kinds FROM tenant_login_prefs LIMIT 1`
  const v = row?.second_factor_kinds
  // An unknown value reads as `off` rather than as a requirement nobody can satisfy: a half-applied
  // migration or a value from a newer deployment must not lock a tenant out of its own product. The
  // CHECK constraint is what keeps this branch unreachable in practice.
  return v === 'any' || v === 'passkey' || v === 'totp' ? v : 'off'
}

/** The kinds a stance accepts. `off` accepts everything — it asks for nothing at all. */
export const acceptedKinds = (stance: FactorStance): FactorKind[] =>
  stance === 'passkey' ? ['passkey'] : stance === 'totp' ? ['totp'] : ['totp', 'passkey']

/**
 * How many admins must be able to satisfy a stance before it may be selected.
 *
 * TWO for `passkey`, one for everything else, and the asymmetry is the ruling on #672 rather than an
 * off-by-one: **a passkey cannot be written down.** A TOTP has a de-facto backup — the QR was
 * photographed, the secret sits in a password manager — and a passkey has none, so the same floor does
 * not buy the same safety. Two makes "every admin loses their key at once" two independent accidents.
 *
 * Counted in KEYS rather than in admins, deliberately: one admin holding two passkeys is as safe from
 * a single loss as two admins holding one each, and refusing the first shape would push a one-admin
 * tenant towards seating a second person for the guard's benefit.
 */
export const floorFor = (stance: FactorStance): number => (stance === 'passkey' ? 2 : 1)

/**
 * Can a member who holds NOTHING enrol something this stance accepts, without a session?
 *
 * ADR-222 §6, and the reason it is a capability question rather than a banned value. The policy denies
 * a session to anybody with nothing enrolled, so the session-less doors — the ones on the factor
 * receipt — are the only way out of that circle. A stance whose accepted kinds none of them can mint is
 * a state nobody can leave, and the switch has to refuse it.
 *
 * rev0 wrote this as "refuse the value `passkey` until the interstitial learns passkeys, then delete
 * the refusal", which is a named-value ban plus a debt to remember. As a predicate it goes true by
 * itself the day a door is added — and a third kind is covered without anybody editing this.
 *
 * The list is what those doors ACTUALLY mint, so it is maintained beside them
 * (`interstitial-doors-678.test.ts` is the walk that says the routes and this list agree).
 */
export const INTERSTITIAL_MINTS: FactorKind[] = ['totp', 'passkey']

export const interstitialCanMint = (stance: FactorStance): boolean =>
  acceptedKinds(stance).some((k) => INTERSTITIAL_MINTS.includes(k))

/**
 * ⚠️ THE EDITION SEAM, and it is deliberately one function that permanently answers true.
 *
 * RULED CE (#644/ ADR-219 §10a, 2026-08-06). ADR-210 §8 decides it: "requiring SSO" is the same
 * shape — a tenant-wide constraint on how everybody signs in — and it was ruled CE on 2026-08-04 with
 * the reason "charging for it would mean the cheaper plan is the one that cannot hold a security
 * position". Sharper: ADR-219 §3 identifies this feature's population as tenants on `platform-oidc`,
 * exactly the set that CANNOT turn SSO required on, so pricing the factor policy would have priced out
 * the population §3 named.
 *
 * So why keep it? Because it is the one PLACE the question would be asked if it were ever asked. Delete
 * it and the next edition question about factors arrives as an `if (plan === …)` beside each of the four
 * policy checks — which is the shape this repository forbids, and forbids for a reason: an entitlement
 * decided in four places is eventually decided differently in four places. The constraint was never
 * about which answer this returns.
 */
export function mfaPolicyEntitled(_tenant: { plan: string }): boolean {
  return true
}

/**
 * THE condition, written once: a factor this member could actually offer AT THIS HOST.
 *
 * Two halves, and the second is the one a reader does not expect. CONFIRMED is ADR-219 §7's rule — an
 * abandoned enrolment has proved nothing, and counting it would let the switch be satisfied by starting
 * one and walking away. HOST is #664's: a passkey's RP ID is the host it was made on, and the sign-in
 * lookup filters by it (`passkeys.ts:211`), so after a domain move every key is still a row and not one
 * of them can answer. A floor that counted rows would be satisfied by keys nobody can present, the
 * switch would accept the setting, and the tenant would be locked out of its own product.
 *
 * A FRAGMENT rather than four similar queries, because #605's two-sided guard is this repository's
 * standing lesson about what happens when the same rule is written twice: one side is updated and the
 * other keeps the old answer. Everything that asks "does this count" embeds this; `factor-kinds.test.ts`
 * is the walk that says nothing else asks the question its own way.
 *
 * TOTP has no host: the secret is the product's, and it verifies wherever the product is served.
 */
export function presentableHere(db: TenantDb, host: string | undefined) {
  const rpId = rpIdFromHost(host)
  return db.sql`
    f.confirmed_at IS NOT NULL AND (
      f.kind <> 'passkey'
      OR EXISTS (SELECT 1 FROM member_passkeys p WHERE p.factor_id = f.id AND p.rp_id = ${rpId}))`
}

/**
 * A DIFFERENT question, deliberately: does this member hold anything a reset would clear (#644)?
 *
 * Same file as `presentableHere` because #675's walk is right to insist that `confirmed_at IS NOT NULL`
 * is spelt in one place — but this one does NOT take the host half, and the reason matters. A member
 * whose only passkeys were made on the tenant's old host holds keys that cannot answer at any door
 * (#664). They are the person who most needs the reset. Asking `presentableHere` would answer "nothing
 * to clear" for exactly them, and the console would withhold the one item that helps.
 *
 * CONFIRMED is kept: an abandoned enrolment is discarded when the next one starts (ADR-219 §7), so
 * offering to "reset" one would name a device the member never finished setting up.
 */
export function holdsAConfirmedFactor(db: TenantDb) {
  return db.sql`
    EXISTS (SELECT 1 FROM member_factors f
            WHERE f.member_sub = m.sub AND f.confirmed_at IS NOT NULL)`
}

/**
 * What this member could present here, as kinds. The answer #672's later slices ask of every door.
 *
 * Returned as the distinct KINDS rather than the rows: every caller's question is "would an accepted
 * kind be available", and handing back rows invites each of them to re-derive that differently.
 */
export async function presentableKinds(
  db: TenantDb, memberSub: string, host: string | undefined,
): Promise<FactorKind[]> {
  const rows = await db.sql<{ kind: FactorKind }[]>`
    SELECT DISTINCT f.kind FROM member_factors f
    WHERE f.member_sub = ${memberSub} AND ${presentableHere(db, host)}`
  return rows.map((r) => r.kind)
}

/**
 * Whether this tenant has an admin who can actually present a factor.
 *
 * The write-time precondition ADR-219 §4 mirrors from #605: turning the policy on while nobody can
 * satisfy it is a lock-out with a success response. CONFIRMED factors only — an abandoned enrolment is
 * somebody who has proved nothing, and counting it would let the switch be satisfied by starting an
 * enrolment and walking away.
 *
 * `role = 'admin'` on the members row is the tier, which is what #605's own guard reads; a custom role
 * carrying admin capabilities is a different question and is not one this precondition can ask without
 * an FGA round trip per member.
 */
export async function adminFactorCount(
  db: TenantDb, stance: FactorStance, host: string | undefined,
): Promise<number> {
  const kinds = acceptedKinds(stance)
  const [row] = await db.sql<[{ n: number }?]>`
    SELECT count(*)::int AS n
    FROM members m
    JOIN member_factors f ON f.member_sub = m.sub AND ${presentableHere(db, host)}
    WHERE m.role = 'admin' AND m.deactivated_at IS NULL AND f.kind = ANY(${kinds})`
  return row?.n ?? 0
}

/** The floor as a yes/no, which is what both sides of the guard actually ask. */
export async function floorMet(
  db: TenantDb, stance: FactorStance, host: string | undefined,
): Promise<boolean> {
  if (stance === 'off') return true // nothing is required, so nobody has to be able to satisfy it
  return (await adminFactorCount(db, stance, host)) >= floorFor(stance)
}

/**
 * Why this stance may not be written — the ONE place that answers it, for both sides of the screen.
 *
 * #672 (review rejection/): the floor threw a single code, `admin_factor_required`, whichever
 * stance had been asked for. The screen mapped that code to the sentence the ON/OFF switch uses —
 * "enrol a second factor on an admin account first" — and said it to an admin whose account already
 * held one. What was actually being asked for (TWO PASSKEYS) appeared nowhere, so there was no way to
 * read the way forward off the screen. The refusal now carries WHICH floor it is.
 *
 * It is a function returning the refusal rather than a throw so the GET can report the same answer the
 * PATCH would give. That matters more than saving a query: the screen greys out the options that cannot
 * be written, and a second implementation of "can it be written" is how the grey and the 409 come to
 * disagree — the shape #605's two-sided guard exists to prevent, and the shape ADR-222 §2 collapsed
 * five copies of into `presentableKinds`.
 *
 * ⚠️ The floor is NOT defended here. This is the convenience half; the fortress is the PATCH refusing
 * (#613: never a gate that only hides). Greying an option out and refusing it are the same sentence
 * said in two places, and the tests break both.
 */
export type StanceRefusal = { code: string; message: string }

export async function stanceRefusal(
  db: TenantDb, stance: FactorStance, host: string | undefined,
): Promise<StanceRefusal | null> {
  if (stance === 'off') return null // nothing is required, so there is nothing to be unable to satisfy
  if (!(await floorMet(db, stance, host))) {
    // #605's precondition, mirrored. Selecting a stance nobody can satisfy is a lock-out wearing a
    // success response — and the person who would have to undo it is the one shut out.
    return stance === 'passkey'
      ? {
          // #685: the number comes from `floorFor`, here as well as on the screen. This sentence used
          // to spell "two" out, so the ruling sat in three places (the constant and two locales) and a
          // change to the floor would have left an API caller reading the old figure.
          code: 'admin_passkey_floor',
          message: `enrol at least ${floorFor('passkey')} passkeys on admin accounts before requiring passkeys — a passkey cannot be written down, so one is a single accident away from locking the workspace.`,
        }
      : stance === 'totp'
        ? {
            code: 'admin_totp_floor',
            message: 'enrol an authenticator app on an admin account before requiring one — an admin whose only factor is a passkey could not satisfy this.',
          }
        : {
            code: 'admin_factor_required',
            message: 'enrol a second factor on at least one admin account before requiring one — otherwise the requirement locks out the people who could turn it off.',
          }
  }
  // ADR-222 §6: a stance nobody can enrol into without a session is a state nobody can leave — the
  // policy denies the session, and the session-less doors are the only way to get a factor. Asked as a
  // capability so it resolves itself when a door is added, rather than as a ban on the word `passkey`
  // with a note to delete it later.
  if (!interstitialCanMint(stance)) {
    return {
      code: 'stance_unreachable',
      message: 'nobody could enrol what this stance asks for: a member with nothing enrolled has no way to add one.',
    }
  }
  // #672 ruling ②-2: a one-member tenant is not offered `passkey` until #650 gives them a way back in.
  // What is exposed there is "the only admin loses their key", which is that ticket's subject.
  if (stance === 'passkey') {
    const [seats] = await db.sql<[{ n: number }?]>`
      SELECT count(*)::int AS n FROM members WHERE deactivated_at IS NULL`
    if ((seats?.n ?? 0) < 2) {
      return {
        code: 'passkey_needs_second_member',
        message: 'requiring passkeys needs a second person in the workspace: losing the only key would leave nobody able to sign in.',
      }
    }
  }
  return null
}

/**
 * Kept for the reading `canEnable` has always had: may the requirement be turned on AT ALL.
 *
 * Expressed through the counter above rather than with a query of its own — the walk in
 * `one-answer-to-presentable-675` exists to keep the condition in one place, and a second count here
 * would be the first drift.
 */
export async function adminWithFactorCount(db: TenantDb, host: string | undefined): Promise<number> {
  return adminFactorCount(db, 'any', host)
}

/**
 * Everyone this stance would refuse — whose sessions ADR-219 §2 revokes when it is written.
 *
 * #679 widened the question from "holds nothing" to "holds nothing THIS STANCE ACCEPTS". Narrowing from
 * `any` to `passkey` is the case: everyone with only an authenticator app stops being able to sign in,
 * and a sweep asking the old question would leave them holding a session the door would now refuse —
 * the "policy that starts tomorrow" ADR-219 §2 rejected, arriving by the new axis.
 *
 * Deactivated members are included rather than skipped: their sessions should already be gone, and a
 * sweep that trusts that has to be right about it. Which of these sessions actually goes is decided by
 * the DOOR at `destroyUnsatisfiedSessions` (§3) — this half only answers "holds nothing".
 */
export async function membersUnsatisfiedBy(
  db: TenantDb, stance: FactorStance, host: string | undefined,
): Promise<string[]> {
  if (stance === 'off') return [] // a stance that asks for nothing leaves nobody unsatisfied
  const kinds = acceptedKinds(stance)
  const rows = await db.sql<{ sub: string }[]>`
    SELECT m.sub FROM members m
    WHERE NOT EXISTS (
      SELECT 1 FROM member_factors f
      WHERE f.member_sub = m.sub AND f.kind = ANY(${kinds}) AND ${presentableHere(db, host)})`
  return rows.map((r) => r.sub)
}

/**
 * Whether removing `factorId` would leave the tenant with no admin who can sign in under the policy.
 *
 * The outbound half of the two-sided guard. #605's is at `admin-login-methods.ts:220-243` and says the
 * same thing about the last credentialed exemption: "the same floor the ON precondition set, or the
 * switch's own requirement dies one delete later".
 *
 * Asked as "would this member still hold one afterwards, and if not, is anybody else left" rather than
 * by counting rows: a member with two authenticators giving one up changes nothing, and a guard that
 * counted admins-with-factors would refuse them for no reason.
 */
export async function wouldStrandTenant(
  db: TenantDb,
  args: { memberSub: string; factorId: string; host: string | undefined },
): Promise<boolean> {
  // #677 review: this asked "is any factor left" while the stance may accept only one KIND, and may
  // ask for TWO of them. So under `passkey` a tenant could take itself from two admin passkeys to none
  // by deleting them one at a time, each delete answering "somebody else still holds one" about a
  // TOTP the door refuses — the floor #676 set on the way in, dismantled on the way out. #605's guard
  // is two-sided for this exact reason, and ADR-222 §2 names this function as one of the five.
  const stance = await secondFactorStance(db)
  if (stance === 'off') return false // nothing is required, so nothing can be stranded
  const kinds = acceptedKinds(stance)
  const [row] = await db.sql<[{ mine: number; others: number }?]>`
    SELECT
      (SELECT count(*)::int FROM member_factors f
        WHERE f.member_sub = ${args.memberSub} AND f.kind = ANY(${kinds}) AND ${presentableHere(db, args.host)}
          AND f.id <> ${args.factorId}) AS mine,
      (SELECT count(*)::int FROM members m
        JOIN member_factors f ON f.member_sub = m.sub AND f.kind = ANY(${kinds}) AND ${presentableHere(db, args.host)}
        WHERE m.role = 'admin' AND m.deactivated_at IS NULL AND m.sub <> ${args.memberSub}) AS others`
  if (!row) return false
  // Counted in FACTORS, not admins, because the floor is: `passkey` asks for two keys, and two on one
  // person is as safe from a single loss as one each on two (#672 ruling ②-1). What has to survive the
  // delete is the floor itself, so the question is whether enough remain — not whether anybody remains.
  if (row.others + row.mine >= floorFor(stance)) return false
  // …and only an ADMIN can strand a tenant. A member losing their last factor locks nobody else out.
  const [me] = await db.sql<[{ role: string }?]>`SELECT role FROM members WHERE sub = ${args.memberSub}`
  return me?.role === 'admin'
}

// #677 / ADR-222 §5: every route that mints or accepts a second factor of a KIND asks whether this
// tenant accepts that kind.
//
// The refusals themselves are pinned in `doors-refuse-unaccepted-677.test.ts`, door by door — eleven
// assertions, each naming a route that exists today. That set is complete and it is worth having. What
// it cannot do is notice a TWELFTH door: a route added next month that mints a passkey without asking,
// while every one of those eleven stays green. The tenant would have selected `totp`, and one endpoint
// would go on handing out passkeys nobody can present.
//
// So this does not name doors. It reads `routes/` for the primitives that COMMIT to a kind — the ones
// that make a factor of a particular sort, or accept one as proof of identity — and requires the
// handler around each call to consult the stance. A new door is discovered by the thing that makes it
// a door.
//
// This is the shape #675 gave `presentableHere`, applied to the other half of the same ADR.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROUTES = resolve(import.meta.dirname, '../routes')

/**
 * Calls that commit to a KIND.
 *
 * Minting one, or accepting one as proof of who somebody is. Both are decisions the tenant's stance
 * gets a say in — the first because it would create a factor the doors refuse, the second because it
 * would let a refused kind open the product anyway.
 */
const COMMITS_TO_A_KIND = [
  'startTotpEnrolment',
  'startPasskeyEnrolment',
  'passkeyRegistrationOptions',
  'passkeyAuthenticationOptions',
  'verifyPasskeyAssertion',
  'verifyPasskeyRegistration',
]

/** How a handler asks. Either spelling — the shared helper, or the predicate it is built from. */
const ASKS = /kindRefusal|acceptedKinds|secondFactorStance/

/**
 * Routes that commit to a kind and are RIGHT not to ask, each with the reason.
 *
 * Keyed by the route path so the exemption cannot silently widen: rename the route and it stops being
 * exempt. Written as an object rather than a set so the reason lives next to the name, and a reader
 * meeting a new exemption has to justify it here rather than in a commit message.
 */
const MAY_NOT_ASK: Record<string, string> = {
  // Giving a factor up is not a way IN, so the stance has no interest in it. Under `passkey`, an
  // authenticator app is not something the tenant accepts — refusing to let somebody delete it would
  // trap a dead row on their account forever. #677's own suite pins this from the other side ("a TOTP
  // can be given up freely under `passkey` — it is guarding nothing").
  'DELETE /me/factors/:id': 'removal is not a door; the stance has no say in what somebody stops holding',
  'POST /me/factors/:id/remove-challenge': 'the challenge for a removal, and removal is not a door',
}

/** Every `app.<verb>(<path>` in the file, with the source span it owns. */
function handlersIn(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = []
  const re = /app\.(get|post|put|patch|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*\n?\s*'([^']+)'/g
  const starts: { name: string; at: number }[] = []
  for (const m of src.matchAll(re)) {
    starts.push({ name: `${m[1]!.toUpperCase()} ${m[2]}`, at: m.index! })
  }
  for (let i = 0; i < starts.length; i++) {
    out.push({ name: starts[i]!.name, body: src.slice(starts[i]!.at, starts[i + 1]?.at ?? src.length) })
  }
  return out
}

const sources = readdirSync(ROUTES)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, src: readFileSync(resolve(ROUTES, f), 'utf8') }))

describe('#677: a door is found by what makes it a door', () => {
  it('the sweep can see the routes it is meant to read', () => {
    // Without this the cases below pass over an empty list — a renamed directory, a build that moves
    // routes elsewhere, and the walk goes quietly green. Measured against the two files that carry
    // factor doors today rather than a count, which would churn.
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(['auth-local.ts', 'second-factor.ts']))
    const handlers = sources.flatMap((s) => handlersIn(s.src))
    expect(handlers.length, 'no route handlers were parsed at all').toBeGreaterThan(20)
  })

  it('finds the doors, and there are more than a couple', () => {
    // The premise. If the primitive names go stale — renamed, wrapped, moved behind a helper — this
    // sweep would find nothing to check and every case below would be vacuously true.
    const doors = sources.flatMap((s) => handlersIn(s.src)
      .filter((h) => COMMITS_TO_A_KIND.some((p) => h.body.includes(`${p}(`)))
      .map((h) => h.name))
    expect(doors.length, `the primitives ${COMMITS_TO_A_KIND.join(', ')} were not found in any handler`)
      .toBeGreaterThan(3)
  })

  it('every door consults the stance, or is named as one that need not', () => {
    const offenders: string[] = []
    for (const { file, src } of sources) {
      for (const h of handlersIn(src)) {
        const commits = COMMITS_TO_A_KIND.filter((p) => h.body.includes(`${p}(`))
        if (!commits.length) continue
        if (h.name in MAY_NOT_ASK) continue
        if (ASKS.test(h.body)) continue
        offenders.push(`${file} ${h.name} calls ${commits.join(', ')} without asking the stance`)
      }
    }
    expect(offenders, `these commit to a kind the tenant may not accept:\n  ${offenders.join('\n  ')}`)
      .toEqual([])
  })

  it('and every exemption still names a route that exists', () => {
    // An exemption for a route that is gone is a hole waiting for somebody to reuse the path. Same
    // reason #623's ledger fails when a line outlives what it excused.
    const all = new Set(sources.flatMap((s) => handlersIn(s.src)).map((h) => h.name))
    const stale = Object.keys(MAY_NOT_ASK).filter((n) => !all.has(n))
    expect(stale, `exempted routes that no longer exist: ${stale.join(', ')}`).toEqual([])
  })
})

import { describe, it, expect } from 'vitest'
import { floorFor } from '../auth/factor-policy.js'

/**
 * #685: THE one place the passkey floor's VALUE is written down in a test.
 *
 * Everything else that cares — the refusal's sentence, the two locales, the cases that enrol keys until
 * the stance is accepted — now derives from `floorFor`, so moving the floor is a one-character edit
 * plus this file. That is the point of the ticket.
 *
 * It would have been tidier to derive here too, and that is exactly the trap: `expect(floorFor('passkey'))
 * .toBe(floorFor('passkey'))` is a tautology, and a suite where EVERY floor assertion is derived would
 * stay green through a typo that quietly halved the guard. So the division is deliberate — this literal
 * is the guard on the RULING, and the derived cases are the guard on the BEHAVIOUR. Neither can cover
 * for the other.
 *
 * The ruling (#672②), so that a future reader changing the number knows what they are overruling:
 * two, rather than one, because A PASSKEY CANNOT BE WRITTEN DOWN. A TOTP has a de-facto backup — the QR
 * was photographed, the secret sits in a password manager — and a passkey has none, so the same floor
 * does not buy the same safety. Two makes "every admin loses their key at once" two independent
 * accidents. Counted in KEYS rather than admins: one admin holding two is as safe from a single loss as
 * two admins holding one each, and refusing that shape would push a one-admin tenant into seating a
 * second person for the guard's benefit.
 */
describe('#685: the passkey floor, as ruled', () => {
  it('is two — and this is the only test that says so', () => {
    expect(floorFor('passkey'), 'the ruling changed; see #672② before accepting this').toBe(2)
  })

  it('and no other stance carries a floor above one', () => {
    // The asymmetry is the ruling. Without this, raising every floor to two would satisfy the case
    // above while quietly making a TOTP-only tenant enrol a second app for no stated reason.
    expect(floorFor('totp')).toBe(1)
    expect(floorFor('any')).toBe(1)
    // `off` is asserted where it means something — `which-kinds-stance-676`, in the case about `off`
    // not being the empty set. Repeating it here would be a second literal for a claim that already
    // has an owner, which is the fault this ticket is removing.
  })
})

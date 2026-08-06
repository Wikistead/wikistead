import { describe, it, expect } from 'vitest'
import { isNarrowedKey } from '@wikistead/hooks'

// #637 / ADR-216 §4: one question — "is this key narrowed" — asked once, answered for every dimension.
//
// The gate used to ask it by testing `capabilities` for truthiness at its own call site. That answers
// "no" for a key confined only by space, and everything narrowing buys hangs off the answer: the refusal
// on credential-minting routes, and the route table. `POST /auth/collab-token` mints a token carrying the
// OWNER's identity, and the live-editing process derives authority from OpenFGA for that subject with no
// knowledge of API keys — so a key confined to one space would have been handed the whole tenant.
//
// The predicate lives beside the seam rather than at the call site so a dimension added next month does
// not require finding the call site again. These are its states, and the two "empty" cases are the ones
// worth writing down: an empty list is a key narrowed to NOTHING, which is the opposite of un-narrowed.
describe('#637: a key is narrowed if it is narrowed in ANY dimension', () => {
  it('says no only when nothing confines it', () => {
    expect(isNarrowedKey({}), 'a plain key').toBe(false)
    expect(isNarrowedKey({ capabilities: null, spaces: null }), 'nulls are not confinement').toBe(false)
  })

  it('says yes for capabilities, as it always did', () => {
    expect(isNarrowedKey({ capabilities: ['view'] })).toBe(true)
    expect(isNarrowedKey({ capabilities: [] }), 'narrowed to nothing is still narrowed').toBe(true)
  })

  it('says yes for spaces — the case the old truthiness test answered wrongly', () => {
    expect(isNarrowedKey({ spaces: new Set(['s1']) })).toBe(true)
    expect(isNarrowedKey({ spaces: new Set<string>() }), 'confined to no space is still confined').toBe(true)
    expect(isNarrowedKey({ spaces: [] }), 'and a list reads the same as a set').toBe(true)
  })

  it('says yes when both confine it', () => {
    expect(isNarrowedKey({ capabilities: ['view'], spaces: new Set(['s1']) })).toBe(true)
  })
})

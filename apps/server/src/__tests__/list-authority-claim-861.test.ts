// #861 (#833 family, fourth): `roles.ts` said the assignment LISTING gate is `manage`. At space scope
// the code asks for `manageAccess`, which ADR-209 (#607) lets a custom role carry WITHOUT making its
// holder a manager — so the prose named a sufficient condition as if it were a necessary one, and a
// reader working out who may see a space's roster got a narrower answer than the code gives.
//
// ADR-257 ruled the shape of the answer: NO corpus-wide checker (the defect is a quantifier, and every
// mechanical form on offer compares verb sets), and instead a pin PER SITE — one file's sentence tied
// to one fact about the tree. This is that pin for this site, in ADR-257 §3(b)'s own words:
//
//     roles.ts must not describe the space listing authority as `manage`
//     while requireListAuthority admits `manageAccess`
//
// ⚠️ The derivation is asserted FIRST and by itself. If the code ever narrows the space arm back to
// `manage`, the prose assertions below would keep passing while describing something true — and the
// pin would have quietly stopped guarding anything. Reading the ternary is what keeps the two halves
// pointing at each other.
//
// The sweep that produced this found FIVE false sentences where the ticket named two (ADR-257 §3(d):
// report the count JUDGED). Sixty-six comment lines in roles.ts claim an authority; the listing ones
// were judged individually, and the four that spoke for the space arm were wrong.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROLES = readFileSync(resolve(import.meta.dirname, '../routes/roles.ts'), 'utf8')
const PICKER_TEST = readFileSync(resolve(import.meta.dirname, 'assignable-roles-485.test.ts'), 'utf8')

/** The comment block that sits directly above a definition or a route, by its unique anchor text. */
function commentAbove(source: string, anchor: string): string {
  const at = source.indexOf(anchor)
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(0)
  const before = source.slice(0, at)
  const lines = before.split('\n')
  const out: string[] = []
  for (let i = lines.length - 2; i >= 0; i--) {
    const l = lines[i]!.trim()
    if (!l.startsWith('//')) break
    out.unshift(l)
  }
  expect(out.length, `no comment block above ${anchor}`).toBeGreaterThan(0)
  return out.join('\n')
}

describe('#861 the listing gate is described as the gate the code asks for', () => {
  it('derives manageAccess at space scope and manage elsewhere', () => {
    // The fact every sentence below is measured against. Written as the line, not as behaviour, because
    // a behavioural test would need a store and this pin must fail on a PROSE edit in a repo with none.
    const body = ROLES.slice(ROLES.indexOf('export async function requireListAuthority'))
    expect(body.slice(0, 900)).toContain("const rel = resourceType === 'space' ? 'manageAccess' : 'manage'")
  })

  it("the function's own header names the space verb", () => {
    const header = commentAbove(ROLES, 'export async function requireListAuthority')
    expect(header, 'the header must name the verb the space arm actually asks for').toContain('manageAccess')
    // The exact sentence that was wrong, in the shape it was wrong in.
    expect(header, 'the header must not call the gate `manage` without qualification')
      .not.toMatch(/it gates on\s*\n?\/\/\s*`manage`/)
  })

  it('the space picker route names the gate rather than restating a narrower rule', () => {
    const above = commentAbove(ROLES, "'/spaces/:spaceId/assignable-roles'")
    expect(above).toContain('requireListAuthority')
    expect(above, 'the space arm is `manageAccess`').toContain('manageAccess')
    expect(above, "…and must not say the space read is gated on `manage`").not.toMatch(/gated on `manage` of the\s*\n?\/\/\s*space/)
  })

  it('the page picker route does not claim the space arm is `manage`', () => {
    const above = commentAbove(ROLES, "'/pages/:pageId/assignable-roles'")
    // It legitimately says the PAGE arm is `manage`; what it may not say is that the space one is.
    expect(above, 'the space endpoint is described by its own verb').toContain('manageAccess')
    expect(above).not.toMatch(/space scope (list and assign are )?both `manage`/)
    expect(above).not.toMatch(/gated on SPACE manage/)
  })

  it('the picker test repeats the same fact, or none', () => {
    // The copy the ticket named. A second home for a sentence is a second place for it to rot, so the
    // one that stays must say what the code does.
    expect(PICKER_TEST.slice(0, 900)).toContain('manageAccess')
    expect(PICKER_TEST.slice(0, 900)).not.toMatch(/requireListAuthority on the space's `manage`/)
  })
})

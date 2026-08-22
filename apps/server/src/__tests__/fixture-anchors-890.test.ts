// #890: the e2e integrity check watches what the seed actually writes.
//
// THE DEFECT: `assertDemoFixtureIntact` read ONE tuple. A run that lost only
// `user:dev-user#manager@space:demo_space` passed it while every space-settings spec failed with an
// empty screen — the tab strip is built from what that tuple grants, so the reds read as a product
// regression. Measured 2026-08-22: mid-run, `space:demo_space` and `page:demo` were down to zero
// tuples while `space:acme_space` still had its two, and the suite reported fourteen failures whose
// single cause was invisible.
//
// The check now walks its whole anchor list — and widening it immediately exposed a second defect:
// one anchor named a relation the model does not accept for that type, so the self-heal's write had
// been refused (and swallowed) on every run since #218 renamed it. That anchor could never pass, and
// a check that can never pass gets deleted. This measures the anchors against the MODEL, because the
// two seeders can agree with each other and both be wrong.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../../../..')
const FIXTURES = resolve(ROOT, 'tests/e2e/fixtures.ts')
const MODEL = resolve(ROOT, 'infra/openfga/model.fga')

// `{ user: 'x', relation: 'y', object: 'z' }` in either quote style, as both files spell it.
const TUPLE = /\{\s*user:\s*['"]([^'"]+)['"],\s*relation:\s*['"]([^'"]+)['"],\s*object:\s*['"]([^'"]+)['"]/g

type Anchor = { user: string; relation: string; object: string }

const anchors: Anchor[] = existsSync(FIXTURES)
  ? [...readFileSync(FIXTURES, 'utf8').matchAll(TUPLE)].map((m) => ({ user: m[1]!, relation: m[2]!, object: m[3]! }))
  : []

// The model, as `type <t>` blocks each holding `define <relation>: ...`. Comparing the anchors against
// the MODEL rather than against the other seeder is the point: the two seeders can agree with each
// other and both be wrong, which is exactly what happened.
const model = existsSync(MODEL) ? readFileSync(MODEL, 'utf8') : ''
const typeBlocks = new Map<string, string>()
{
  const parts = model.split(/^type /m).slice(1)
  for (const part of parts) {
    const name = /^(\w+)/.exec(part)?.[1]
    if (name) typeBlocks.set(name, part)
  }
}
// The direct-write types a relation accepts, e.g. `define view_base: [user:*] or view_direct or …`
// yields ['user:*']. `null` means the relation is not defined on that type at all; an empty list means
// it is defined but accepts no direct writes (a computed relation).
const directTypes = (objectType: string, relation: string): string[] | null => {
  const block = typeBlocks.get(objectType)
  if (!block) return null
  const m = new RegExp(`^\\s*define ${relation}:(.*)$`, 'm').exec(block)
  if (!m) return null
  const bracket = /\[([^\]]*)\]/.exec(m[1]!)
  if (!bracket) return []
  return bracket[1]!.split(',').map((t) => t.trim()).filter(Boolean)
}

// How a tuple's user side appears in a type list: `user:dev-user` → `user`, `user:*` → `user:*`,
// `tenant:tenant_dev#member` → `tenant#member`.
const userShape = (user: string): string => {
  if (user.endsWith(':*')) return user
  if (user.includes('#')) return `${user.split(':')[0]}#${user.split('#')[1]}`
  return user.split(':')[0]!
}

describe('#890 every e2e anchor is a tuple the model will accept', () => {
  it('finds the anchors and the model at all', () => {
    // Without this, a moved file empties both and every case below passes on nothing.
    expect(existsSync(FIXTURES), `${FIXTURES} is gone`).toBe(true)
    expect(existsSync(MODEL), `${MODEL} is gone`).toBe(true)
    expect(anchors.length, 'no anchors parsed').toBeGreaterThanOrEqual(10)
    expect(typeBlocks.size, 'no types parsed out of the model').toBeGreaterThanOrEqual(4)
  })

  it.each(anchors.map((a) => [`${a.user}#${a.relation}@${a.object}`, a] as const))(
    '%s is a tuple the model accepts',
    (_label, a) => {
      // THE DEFECT this catches: `share_link:demo_view_perm#view_base@page:demo` sat here for months.
      // ⚠️ `view_base` IS defined — asking only that much passes this anchor, which is how the first
      // version of this pin was vacuous against the very case it names. What the model refuses is the
      // TYPE: view_base takes `[user:*]`, and #218 moved link grants to the `view_direct` leaf. So
      // OpenFGA rejected the write on every run, the best-effort catch swallowed it, and the anchor
      // was permanently absent — which then read as "a spec deleted it" the first time the integrity
      // check looked at more than one tuple. An anchor that can never be written is a check that can
      // never pass, and a check that can never pass gets deleted.
      const objectType = a.object.split(':')[0]!
      const allowed = directTypes(objectType, a.relation)
      expect(allowed, `type ${objectType} has no relation ${a.relation}`).not.toBeNull()
      const shape = userShape(a.user)
      expect(
        allowed!.some((t) => t === shape || t.startsWith(`${shape} with `)),
        `${a.relation} on ${objectType} accepts [${allowed!.join(', ')}] — not ${shape}`,
      ).toBe(true)
    },
  )

  it('watches the grant whose loss made the reds look like a product bug', () => {
    // The tab strip on every space-settings screen is built from what this grant gives. Losing it made
    // fourteen specs fail with an empty screen while the one-tuple check said the fixture was fine.
    expect(anchors.map((a) => `${a.user}#${a.relation}@${a.object}`))
      .toContain('user:dev-user#manager@space:demo_space')
  })

  it('watches more than the one tuple #279 left behind', () => {
    expect(anchors.length, 'the integrity check is back down to a single tuple').toBeGreaterThanOrEqual(10)
  })
})

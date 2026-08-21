// #856 / ADR-257: the sentence above a share-link route says what the code actually requires.
//
// #833 found five comments that were wrong about authority; these were the costliest. Both said
// issuing and listing share links "requires `manage`", and since #420 3b the gate has been the SHARE
// class — `share` on a page, `share` or `manage` on a space. The reader this misleads is the one
// deciding who may see a resource's links, and an unpassworded link id IS its credential (app.ts
// treats these routes as credential reads, not page reads), so "administrators only" was the exact
// wrong belief to hand them.
//
// ⚠️ WHY A PIN OF ITS OWN, and not one more rule in a general checker. The lie was a SUFFICIENT
// condition stated as a NECESSARY one: `manage` really does pass (through page#share's superset arm,
// and directly on a space), so every set-comparison a generic checker could make was satisfied. Only
// what the gate accepts separates the true sentence from the false one.
//
// ⚠️ WHAT THIS MEASURES, EXACTLY — the review of the first version found this header claiming more
// than the code did, which is the defect the ticket is about:
//
//   * it reads the gate's SOURCE for a `check(… 'share' …)`, not its behaviour. Hoisting that literal
//     into a constant is a behaviour-preserving refactor that this would misread;
//   * it finds routes by their DIRECT call to the gate. A route reached through a private wrapper is
//     invisible to it;
//   * it judges a comment BLOCK, not the file: a block that names `manage` as a requirement without
//     naming `share` anywhere in it is the shape #833 found. A block that explains both arms passes,
//     however it is worded or wrapped.
//
// What it does NOT do is fix the prose in place: while the gate accepts `share` the claim is refused,
// and in a world where somebody removes that arm this file asserts nothing about the wording at all —
// the sentence would be true again, and pinning it either way would be pinning prose.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'apps/server/src/routes/share-links.ts'
const SOURCE = readFileSync(join(import.meta.dirname, '../../../..', FILE), 'utf8')
const LINES = SOURCE.split('\n')
const GATE = 'requireShareOnResource'

/** The gate's own body — the fact every claim below is measured against. */
function gateBody(): string {
  const start = LINES.findIndex((l) => new RegExp(`function ${GATE}\\s*\\(`).test(l))
  expect(start, `${FILE} still defines ${GATE}`).toBeGreaterThan(-1)
  const end = LINES.findIndex((l, i) => i > start && l === '}')
  expect(end, `the body of ${GATE} is readable (its closing brace was found)`).toBeGreaterThan(start)
  return LINES.slice(start, end + 1).join('\n')
}

/** Every exported function that puts the gate in front of itself, with the prose above it. */
function guardedRoutes(): { name: string; comment: string }[] {
  const out: { name: string; comment: string }[] = []
  LINES.forEach((line, i) => {
    if (!new RegExp(`await ${GATE}\\(`).test(line)) return
    // The enclosing export: the nearest `export … function NAME(` above this call.
    let decl = -1
    for (let j = i; j >= 0; j -= 1) {
      if (/^export (?:async )?function \w+/.test(LINES[j]!)) { decl = j; break }
    }
    if (decl === -1) return // the gate's own definition, or a helper — not a route
    const name = /^export (?:async )?function (\w+)/.exec(LINES[decl]!)![1]!
    // The comment block immediately above the declaration: what a reader reads before the signature.
    const comment: string[] = []
    for (let j = decl - 1; j >= 0 && /^\s*(\/\/|\/\*|\*)/.test(LINES[j]!); j -= 1) comment.unshift(LINES[j]!)
    if (!out.some((o) => o.name === name)) out.push({ name, comment: comment.join('\n') })
  })
  return out
}

describe('#856: a share-link route says the authority the gate actually accepts', () => {
  it('found the gate and the routes that stand behind it', () => {
    // An empty walk agrees with everything (#719). Three routes stand behind this gate today —
    // issuing, listing and revoking — and finding fewer means the file moved, not that the product
    // grew simpler.
    const routes = guardedRoutes()
    expect(routes.map((r) => r.name).sort(), `routes guarded by ${GATE}: ${routes.map((r) => r.name).join(', ')}`)
      .toEqual(['createShareLink', 'listShareLinks', 'revokeShareLink'])
    expect(routes.filter((r) => r.comment.trim() !== '').length,
      'every guarded route carries prose above it — a route with none is a route this test cannot hold')
      .toBe(routes.length)
  })

  it('nothing reaches the gate except those three calls', () => {
    // The walk follows DIRECT calls, so a private wrapper around the gate would carry a fourth route
    // past it in silence (measured on a fixture during review). Counting the references closes that:
    // one definition, three calls, and a fourth mention of the name has to be looked at.
    // CODE mentions only: the prose above two of the routes names the helper on purpose, and counting
    // those would make the number move whenever somebody improves a sentence.
    const inCode = LINES.filter((l) => l.includes(GATE) && !/^\s*(\/\/|\*)/.test(l))
    expect(inCode.length,
      `${GATE} is reached from ${inCode.length} places in code (1 definition + 3 routes) — a new one is a caller this test has not read:\n${inCode.join('\n')}`)
      .toBe(4)
  })

  it('while the gate accepts `share`, no route claims `manage` is what it takes', () => {
    const accepts = /check\([^)]*'share'/.test(gateBody())
    const routes = guardedRoutes()

    // A requirement sentence names a relation. The lie is naming `manage` as the requirement while
    // saying nothing about `share` — true of a stricter gate, false of this one.
    // Judged per BLOCK, not per line. The first version asked one line to carry both relations, which
    // let the same lie through when it wrapped ("… requires\n// `manage` …") and refused a true
    // sentence whose mention of `share` fell on the previous line. What a reader takes away is the
    // paragraph.
    const claims = routes
      // `share` the RELATION, not "share links" the noun: the original lie said "…active share links
      // … Requires `manage`", so a bare word test would have read its own subject as the answer.
      .filter((r) => /\b(require|gated on|only .*\bcan\b)/i.test(r.comment) && /`manage`/.test(r.comment) && !/(`share`|share[- ]class)/i.test(r.comment))
      .map((r) => `${r.name}: ${r.comment.split('\n').find((l) => /`manage`/.test(l))?.trim() ?? ''}`)

    if (!accepts) return // not this file's world — see the header

    expect(claims, 'these say `manage` is what it takes while the gate accepts `share` — the #833 defect, restated')
      .toEqual([])
  })
})

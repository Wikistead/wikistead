import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'

// #637 / ADR-216 §5 (ruling: raised to an acceptance criterion): count the calls the AND cannot reach.
//
// A restriction in the ambient scope narrows what `check`, `checkRelation` and `filterAuthorized` will
// say yes to. It does not narrow a call that goes straight to the FGA client, because there is no
// primitive in the way. Those calls are not defects — several are the tenant gate, which is not a
// question about a space, and one is the primitive layer's own plumbing. What they are is the reason
// COMPLETENESS lives somewhere else: the allow-list of routes a narrowed key may enter is the guarantee,
// and the AND at the primitives is a second layer beneath it.
//
// So this does not forbid them. It COUNTS them, without a hand-copied list, so that a thirteenth appears
// as a red line on the day it is written rather than as a quiet hole discovered later. The reviewer of
// that day decides whether it needs a route-table entry; what must not happen is nobody being asked.
const ROOTS = [
  resolve(import.meta.dirname, '..'),
  resolve(import.meta.dirname, '..', '..', '..', '..', 'packages'),
]

/** Every .ts source file under the roots, excluding tests and build output. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__' ? [] : sources(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : []
  })
}

/** A call that reaches OpenFGA without passing a primitive. */
const RAW = /\b(?:fga|fgaClient|client)\s*\.\s*(?:check|listObjects)\s*\(/g

function rawCalls(): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = []
  for (const root of ROOTS) {
    for (const file of sources(root)) {
      const src = readFileSync(file, 'utf8')
        // comments explain these calls; counting the prose would count the explanation
        .split('\n').map((l) => l.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '')).join('\n')
      const n = (src.match(RAW) ?? []).length
      // Paths are keyed relative to the repo root, not to whatever directory the checkout happens
      // to live in — the same scan has to produce the same keys from any clone.
      if (n > 0) out.push({ file: relative(resolve(import.meta.dirname, '..', '..', '..', '..'), file), count: n })
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

describe('#637: the calls the AND cannot reach are counted, not assumed', () => {
  it('the scan works at all (a broken pattern must not pass by finding nothing)', () => {
    const found = rawCalls()
    expect(found.length, 'files with raw calls').toBeGreaterThan(3)
    expect(found.map((f) => f.file).join('\n'), 'the tenant gate is among them — it is the known case')
      .toMatch(/tenant-admin\.ts/)
  })

  it('there are no more of them than there were when this was measured', () => {
    // NINETEEN, in nine files, on 2026-08-06. ADR-216 says twelve, and measuring beats the document:
    // its count was taken over route files with a narrower pattern and missed `fga.check(` spellings
    // outside them. Recorded here rather than quietly adopted — the ADR has already been wrong about a
    // count once, in the direction that made the problem look smaller, and a second silent correction
    // would make the number look agreed rather than measured.
    //
    // The number is here so a change has to be looked at; it is NOT a claim that nineteen is correct or
    // that a twentieth is wrong. Six are the tenant gate, which a space restriction is silent about by
    // design, and two are inside the primitive layer itself.
    //
    // If this is red because a call was ADDED: decide whether the route that reaches it belongs in
    // `NARROWED_KEY_ROUTES`, because the primitives will not narrow it. If it is red because one was
    // REMOVED, lower the number — that is the direction this is meant to move.
    const found = rawCalls()
    const total = found.reduce((n, f) => n + f.count, 0)
    expect(total, `raw FGA calls, by file ::\n${found.map((f) => `${f.count}  ${f.file}`).join('\n')}`).toBe(19)
  })

  it('the code says which layer is the guarantee, in that order', () => {
    // The ruling asked for this in the code and not only in the ADR: written the other way round, it
    // reads as an invitation to add a route and trust the primitives to catch what it does.
    const src = readFileSync(resolve(ROOTS[1]!, 'authz', 'src', 'restriction.ts'), 'utf8')
    expect(src, 'the allow-list is named as where completeness lives').toMatch(/allow-list/)
    expect(src, 'and this layer says it is the second one, not the guarantee').toMatch(/SECOND layer/)
  })
})

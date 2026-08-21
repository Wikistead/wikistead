// #831: two formulas for a group's authorization-store id, disagreeing about one byte.
//
// `apps/server/src/auth/group-sync.ts` separated the tenant from the group name with a NUL; the copy
// in `infra/openfga/resync.ts` — the script that rebuilds a wiped or migrated store — used a SPACE.
// Same inputs, different hash. So a recovery run wrote every group membership under an id nothing
// grants to: group-granted access gone for everyone, fail-closed, and the script reporting success.
// The worst possible moment for it, because a rebuild happens when authorization is already broken.
//
// The copy's own comment said it "MUST match group-sync.ts exactly, or a rebuilt group membership
// lands on the wrong id and group grants silently break". It said that for four months while not
// matching. ⚠️ That is the lesson this file exists for: **a comment asking two files to agree is not
// a mechanism.** The formula now lives in one place, and what is pinned below is that it stays there
// — a comparison test between two copies would still permit a third.
//
// How the divergence got in: #744 (`db3f1a39`) replaced a literal NUL byte with the escape `\x00`
// because the literal made the source file BINARY to git. The rebuild script was written before that,
// from a file nobody could read, and the invisible byte was copied as a space.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { groupFgaId, groupGrantee } from '@wikistead/authz'
import { groupFgaId as fromServer } from '../auth/group-sync.js'

const root = resolve(import.meta.dirname, '../../../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

// #848: the discovery below walks the tree instead of reading a list of two files. What is skipped is
// the machinery, never a source directory — a list of source paths is the thing this file is fixing.
const SKIP = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage', 'docs-site', 'lp'])
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p)
  }
  return out
}
const rel = (p: string) => p.slice(root.length + 1)

describe('#831: one formula for a group id', () => {
  it('the separator is the NUL byte the production store was written with', () => {
    // Written out rather than compared against the function under test — which would pass whatever
    // the function did. The store holds ids made this way; the code has to keep agreeing with the
    // DATA, and the data cannot be re-hashed.
    const expected = createHash('sha256').update('tenant_dev\x00Engineering').digest('hex').slice(0, 24)
    expect(groupFgaId('tenant_dev', 'Engineering')).toBe(expected)
    // …and emphatically NOT the space-separated one the rebuild script used.
    const spaced = createHash('sha256').update('tenant_dev Engineering').digest('hex').slice(0, 24)
    expect(groupFgaId('tenant_dev', 'Engineering')).not.toBe(spaced)
  })

  it('the separator is what stops two different pairs colliding', () => {
    // The reason it is not a space: a space can appear in a group name, so `("a b", "c")` and
    // `("a", "b c")` would concatenate to the same string. A NUL cannot appear in either half.
    expect(groupFgaId('a b', 'c')).not.toBe(groupFgaId('a', 'b c'))
  })

  it('the server re-exports the shared function rather than keeping its own', () => {
    expect(fromServer).toBe(groupFgaId)
    expect(groupGrantee('tenant_dev', 'Engineering')).toBe(`group:${groupFgaId('tenant_dev', 'Engineering')}#member`)
  })

  // Discovery, and the shape that matters: not "do the two copies agree" (which permits a third), but
  // "is there more than one place that hashes a group id at all".
  //
  // #848: it used to read TWO NAMED FILES — the two that had already diverged — while its own name
  // said "anywhere". A third copy in `infra/openfga/migrate-*.ts` would have passed, and a script
  // exactly like that is where the first copy came from. It walks the tree now.
  it('nothing anywhere hashes a group id a second time', () => {
    const files = sourceFiles(root)
    // The shape, not the word: a sha256 truncated to 24 hex characters IS the group-id derivation.
    // Hashing alone is far too common to mean anything — 33 files reach for `createHash` (tokens,
    // PKCE, the audit chain), and even hash-then-truncate is a family of five legitimate derivations
    // (the analytics IP pseudonym at 16, the transparency pseudonym at 12, the guest anon id at 12).
    // Only the group id truncates at 24, so that is what this asks about, and the assertion below
    // fails loudly if a second one ever picks the same width for something else.
    const derivations = files.filter((f) => /createHash\([\s\S]{0,400}?slice\(0,\s*24\)/.test(readFileSync(f, 'utf8')))
    const outside = derivations.map(rel).filter((f) => f !== 'packages/authz/src/group-id.ts' && !f.endsWith('group-id-one-formula-831.test.ts'))
    console.error(`group id: ${files.length} source file(s) walked, ${derivations.length} derive an id by truncating a hash to 24`)
    expect(files.length, 'the walk found no source files — it is broken, not clean').toBeGreaterThan(500)
    expect(derivations.map(rel), 'the one definition is not among what was walked — the walk missed it')
      .toContain('packages/authz/src/group-id.ts')
    expect(outside, 'a second place derives a group id — the formula has been copied again').toEqual([])
  })

  // #848, the other direction: a copy of the FORMULA is one way to get a wrong id, and building the
  // PRINCIPAL without the formula is the other. #854 was the second kind — the search filter composed
  // `group:<name>` while the index holds `group:<hash>`, so group-granted pages matched nothing — and
  // no pin here could see it, because nothing was hashed twice.
  it('shipped code composes a group principal only through the one formula', () => {
    const shipped = sourceFiles(root).filter((f) => !/__tests__|\.test\.[tj]sx?$/.test(f))
    const sites: { file: string; expr: string }[] = []
    for (const f of shipped) {
      // ⚠️ NOT anchored to a backtick. The first draft of this pin matched only `` `group:${…} `` at
      // the START of a template, and #854's own line — `viewerGroups = "group:${g}"`, the defect this
      // half exists for — sits in the middle of one. The break-check caught it: reverting the fix left
      // the pin green. Anywhere in the file is the rule.
      for (const m of readFileSync(f, 'utf8').matchAll(/group:\$\{([^}]*)\}/g)) sites.push({ file: rel(f), expr: m[1]! })
    }
    console.error(`group id: ${sites.length} place(s) in shipped code compose a \`group:\` principal`)
    expect(sites.length, 'no shipped code composes a group principal — the walk is broken').toBeGreaterThan(0)
    expect(
      sites.filter((s) => !s.expr.includes('groupFgaId(')).map((s) => `${s.file}: ${s.expr}`),
      'a group principal is built from something other than the one formula (#854 was this shape)',
    ).toEqual([])
  })

  it('the rebuild script imports both promises it used to copy', () => {
    // The suspension allowlist was the same shape one comment down — inlined, with the same "MUST
    // match that file" promise, and nothing comparing them either. It had not drifted yet.
    const src = read('infra/openfga/resync.ts')
    expect(src).toMatch(/import \{ groupFgaId \} from '@wikistead\/authz'/)
    expect(src).toMatch(/import \{ grantsShouldBeRebuilt \} from/)
    expect(src, 'a local definition would be the copy coming back').not.toMatch(/const groupFgaId\s*=/)
    expect(src).not.toMatch(/const REASONS_THAT_KEEP_GRANTS/)
  })
})

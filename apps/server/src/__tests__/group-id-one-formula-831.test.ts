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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { groupFgaId, groupGrantee } from '@wikistead/authz'
import { groupFgaId as fromServer } from '../auth/group-sync.js'

const root = resolve(import.meta.dirname, '../../../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

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
  it('nothing anywhere hashes a group id a second time', () => {
    // ⚠️ CE paths only. Naming the proprietary package's file here would make this test unrunnable in
    // the public tree, where that path does not exist (#178 / #785 — and the discovery pins for both
    // caught exactly that on the first run of this file).
    const files = ['infra/openfga/resync.ts', 'apps/server/src/auth/group-sync.ts']
    for (const f of files) {
      expect(read(f), `${f} builds a group id from crypto instead of importing the one formula`)
        .not.toMatch(/createHash\([\s\S]{0,400}?slice\(0,\s*24\)/)
    }
    // The one definition, where it belongs.
    expect(read('packages/authz/src/group-id.ts')).toMatch(/createHash\('sha256'\)/)
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

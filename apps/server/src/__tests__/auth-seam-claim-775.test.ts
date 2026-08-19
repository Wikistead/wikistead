// #775: the auth-provider seam's comment said "EE registers providers here to add SAML, LDAP, SCIM,
// etc." in the present tense. Nothing registers there — the EE build's SAML arrives through
// registerEeFeatures — and LDAP is not implemented anywhere. packages/hooks publishes as CE, so the
// sentence read to anyone weighing the paid build as a feature list. Same defect #734 was bounced
// for in the docs: a capability named in the present tense that does not exist.
//
// A comment cannot be trusted to stay true on its own, so this asks the tree: as long as nothing
// registers, the file must say nothing registers — and the day something does, this fails and points
// at the sentence to rewrite rather than leaving a paragraph that is quietly wrong.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = join(import.meta.dirname, '../../../..')
const SEAM = 'packages/hooks/src/auth-providers.ts'
const CLAIM = 'NOTHING REGISTERS HERE TODAY'

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__' || entry === 'tests') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.tsx?$/.test(path)) out.push(path)
  }
  return out
}

describe('#775 the seam says what is actually plugged into it', () => {
  it('keeps the "nothing registers" claim true in both directions', () => {
    const files = [...sources(join(REPO, 'apps')), ...sources(join(REPO, 'packages'))]
    expect(files.length).toBeGreaterThan(100) // the walk read the tree, not an empty directory

    const registrants = files
      .map((f) => relative(REPO, f))
      .filter((rel) => rel !== SEAM && rel !== 'packages/hooks/src/index.ts')
      .filter((rel) => /registerAuthProvider\s*\(/.test(readFileSync(join(REPO, rel), 'utf8')))

    const seam = readFileSync(join(REPO, SEAM), 'utf8')
    if (registrants.length === 0) {
      expect(seam, `${SEAM} must say that nothing registers, because nothing does`).toContain(CLAIM)
    } else {
      expect(
        seam,
        `${registrants.join(', ')} now registers a provider — rewrite the seam's comment, which still says nothing does`,
      ).not.toContain(CLAIM)
    }
  })

  it('does not name a mechanism this repository has not built', () => {
    const seam = readFileSync(join(REPO, SEAM), 'utf8')
    // LDAP is a future ticket, not a feature. It may be MENTIONED here only as the thing the old
    // wording wrongly implied — never as something a build offers.
    const asOffered = seam.split('\n').filter((l) => /\bLDAP\b/.test(l) && !/not implemented|wrongly|previous wording|reads to/.test(l))
    expect(asOffered, 'LDAP is named outside the sentence that says it does not exist').toEqual([])
  })
})

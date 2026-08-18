// #734 / ADR-237 §2.2: a knob the code reads is a knob the reference names.
//
// The measurement the ticket was raised on: the code read about ninety environment variables and
// `.env.example` declared forty. Lockout windows, token lifetimes, the platform OIDC block, the
// import threshold, the downgrade grace period — an operator had no way to learn any of them
// existed. `docs:gen` now refuses to produce a reference the code does not back, and this puts the
// same comparison inside the suite, so `pnpm test` says it too rather than only the docs build.
//
// The walk lives in `scripts/env-catalog.mjs` and is shared with the generator on purpose: two
// implementations of "what counts as reading the environment" would disagree, and the one nobody
// runs would be the one that goes stale.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error — repo-root script module, no types (#621 convention)
import { ENV_DOCS, ENV_SCAN, scanEnvUsage, scanStringLiterals, scanEnvExample, evaluateEnvCatalog } from '../../../../scripts/env-catalog.mjs'
// @ts-expect-error — repo-root script module, no types (#621 convention)
import { EE_SERVER_SRC_CANDIDATES } from '../../../../scripts/ee-source-root.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const docs = ENV_DOCS as Record<string, { indirect?: boolean; where?: string[]; internal?: string; what?: string; group?: string }>

function measure() {
  const used = scanEnvUsage(root) as Map<string, Set<string>>
  const indirect = Object.entries(docs).filter(([, r]) => r.indirect)
  const extra = [...new Set(indirect.flatMap(([, r]) => r.where ?? []))]
  const literals = scanStringLiterals(root, indirect.map(([n]) => n), undefined, extra) as Set<string>
  const example = scanEnvExample(readFileSync(resolve(root, '.env.example'), 'utf8')) as Set<string>
  return { used, literals, example }
}

describe('#734: the environment reference and the code agree', () => {
  it('every variable the code reads has a row, and no row outlives its reader', () => {
    const { used, literals, example } = measure()
    const violations = evaluateEnvCatalog({ used: new Set(used.keys()), literals, example }) as string[]
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('the walk actually found the environment (a walk that finds nothing would agree with anything)', () => {
    // The vacuity guard #719 taught: an empty scan satisfies "every variable is documented" perfectly.
    const { used } = measure()
    expect(used.size).toBeGreaterThan(50)
    for (const anchor of ['DATABASE_URL', 'OPENFGA_API_URL', 'NODE_ENV']) {
      expect([...used.keys()], `the walk lost ${anchor}`).toContain(anchor)
    }
  })

  it('a new variable with no row is reported by name', () => {
    // The failure a developer will actually meet, driven through the evaluator rather than by
    // writing a file into the tree.
    const violations = evaluateEnvCatalog({
      used: new Set(['NEWLY_ADDED_KNOB']),
      literals: new Set<string>(),
      example: new Set<string>(),
      docs: { EXISTING: { group: 'Runtime', what: 'x' } },
    }) as string[]
    expect(violations.some((v) => v.startsWith('NEWLY_ADDED_KNOB:'))).toBe(true)
  })

  it('a row for a variable nothing reads is reported too', () => {
    const violations = evaluateEnvCatalog({
      used: new Set<string>(['STILL_READ']),
      literals: new Set<string>(),
      example: new Set<string>(),
      docs: { STILL_READ: { group: 'Runtime', what: 'x' }, GONE: { group: 'Runtime', what: 'x' } },
    }) as string[]
    expect(violations.some((v) => v.startsWith('GONE:'))).toBe(true)
  })

  it('an indirect row survives only while its name is still somewhere in the code', () => {
    const docsFixture = { HIDDEN: { group: 'Runtime', indirect: true, what: 'read through a computed key' } }
    const gone = evaluateEnvCatalog({ used: new Set(['X']), literals: new Set<string>(), example: new Set<string>(), docs: { ...docsFixture, X: { what: 'x' } } }) as string[]
    expect(gone.some((v) => v.startsWith('HIDDEN:'))).toBe(true)
    const present = evaluateEnvCatalog({ used: new Set(['X']), literals: new Set(['HIDDEN']), example: new Set<string>(), docs: { ...docsFixture, X: { what: 'x' } } }) as string[]
    expect(present).toEqual([])
  })

  it('every operator-facing row says what the variable does, in a group the page knows', () => {
    // A row with an empty sentence would satisfy the comparison above and tell a reader nothing.
    for (const [name, row] of Object.entries(docs)) {
      if (row.internal) {
        expect(row.internal.length, `${name}: the "not for operators" reason is empty`).toBeGreaterThan(20)
        continue
      }
      // A complete sentence, not a length competition: "SMTP port." says everything there is to
      // say about SMTP_PORT, and a threshold that rejected it would push somebody to pad it.
      expect(row.what ?? '', `${name}: no description`).toMatch(/^.{8,}[.!]$/s)
      expect(row.group, `${name}: no group`).toBeTruthy()
    }
  })

  it('the CE walk does not enter the EE package (that directory is absent from the CE build)', () => {
    // Asserted through the resolver, because #178 is moving that package and a path typed here would
    // keep passing while the walk quietly started reading EE source.
    const homes = (EE_SERVER_SRC_CANDIDATES as string[]).map((c) => c.replace(/\/src$/, ''))
    expect(homes.length).toBeGreaterThan(1)
    for (const home of homes) expect(ENV_SCAN.skipPaths).toContain(home)
    const { used } = measure()
    // The EE-only variables are documented by the EE generator; if the CE walk found one, the CE
    // reference would demand a row for a variable the public tree cannot even see being read.
    for (const eeOnly of ['MANAGED_EMAIL_API_KEY', 'WKS_PSEUDONYM_PEPPER']) {
      expect([...used.keys()], `the CE walk reached into the EE package and found ${eeOnly}`).not.toContain(eeOnly)
    }
  })
})

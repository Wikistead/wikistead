// doc↔code linkage evaluator (#139 / ADR-080). Verifies the MECHANISM with synthetic
// changed-file sets (independent of which repos are checked out): a designated code region
// changed without its docs page → violation; with its docs page → none; an unrelated
// change → none; glob matching (`**`, `*`) behaves. Also checks the real DOC_CODE_MAP is
// well-formed.
import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs script module, no types (pure JS CI helper)
import { evaluateDocLinks, matchesAny, globToRegExp, DOC_CODE_MAP } from '../../../../scripts/doc-code-map.mjs'

const MAP = [
  { label: 'levers', kind: 'generated', code: ['packages/entitlements/src/index.ts'], doc: 'docs/generated/entitlement-levers.md' },
  { label: 'macros', kind: 'authored', code: ['apps/web/src/editor/macros/**'], doc: 'wikistead-docs/macros.md' },
]

describe('doc↔code linkage evaluator (#139 / ADR-080)', () => {
  it('flags a code region changed WITHOUT its docs page', () => {
    const v = evaluateDocLinks(['packages/entitlements/src/index.ts'], MAP)
    expect(v).toHaveLength(1)
    expect(v[0].label).toBe('levers')
    expect(v[0].changedCode).toEqual(['packages/entitlements/src/index.ts'])
  })

  it('passes when the docs page changed WITH the code', () => {
    const v = evaluateDocLinks(['packages/entitlements/src/index.ts', 'docs/generated/entitlement-levers.md'], MAP)
    expect(v).toHaveLength(0)
  })

  it('ignores changes outside any designated region', () => {
    expect(evaluateDocLinks(['README.md', 'apps/server/src/db/pool.ts'], MAP)).toHaveLength(0)
  })

  it('matches via `**` globs (nested files under a region)', () => {
    const v = evaluateDocLinks(['apps/web/src/editor/macros/mermaid.ts'], MAP)
    expect(v).toHaveLength(1)
    expect(v[0].label).toBe('macros')
  })

  it('glob semantics: `*` does not cross `/`, `**` does', () => {
    expect(matchesAny('a/b.ts', ['a/*.ts'])).toBe(true)
    expect(matchesAny('a/x/b.ts', ['a/*.ts'])).toBe(false) // * must not cross /
    expect(matchesAny('a/x/b.ts', ['a/**'])).toBe(true) // ** crosses /
    expect(globToRegExp('a/*.ts').test('a/b.ts')).toBe(true)
  })

  it('the real DOC_CODE_MAP is well-formed (label/code/doc/kind present)', () => {
    expect(DOC_CODE_MAP.length).toBeGreaterThan(0)
    for (const e of DOC_CODE_MAP) {
      expect(e.label).toBeTruthy()
      expect(Array.isArray(e.code) && e.code.length).toBeTruthy()
      expect(e.doc).toBeTruthy()
      expect(['generated', 'authored']).toContain(e.kind)
    }
  })
})

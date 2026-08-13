// doc↔code linkage evaluator (#139 / ADR-080). Verifies the MECHANISM with synthetic
// changed-file sets (independent of which repos are checked out): a designated code region
// changed without its docs page → violation; with its docs page → none; an unrelated
// change → none; glob matching (`**`, `*`) behaves. Also checks the real DOC_CODE_MAP is
// well-formed.
import { readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs script module, no types (pure JS CI helper)
import { evaluateDocLinks, evaluateSurfaceDocs, matchesAny, globToRegExp, DOC_CODE_MAP } from '../../../../scripts/doc-code-map.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

// Repo-relative paths under the source dirs the map can reference (excludes build output).
function repoFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === 'dist' || e === '.git') continue
      const full = join(dir, e)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(relative(repoRoot, full).split('\\').join('/'))
    }
  }
  for (const d of ['apps', 'packages', 'docs']) walk(join(repoRoot, d))
  return out
}

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

  it('no DEAD code globs — every map entry matches a real file (no silent linkage gap)', () => {
    // A typo'd or moved code region would silently never fire (the linkage check would
    // never bind it). Assert every entry's code globs match at least one existing file.
    const files = repoFiles()
    for (const e of DOC_CODE_MAP) {
      const matched = files.some((f: string) => matchesAny(f, e.code))
      expect(matched, `"${e.label}" code globs ${JSON.stringify(e.code)} match no file`).toBe(true)
    }
  })

  it('generated docs referenced by the map exist in-repo', () => {
    const files = new Set(repoFiles())
    for (const e of DOC_CODE_MAP) {
      if (e.kind === 'generated') expect(files.has(e.doc), `${e.doc} missing`).toBe(true)
    }
  })
})

// #697 / ADR-225 §4.2 — the surface-ledger evaluator, break-checked with synthetic registries so
// each refusal direction is measured (a green suite must not rest on the ledger happening to match).
describe('surface-docs evaluator (#697 / ADR-225 §4.2)', () => {
  const LEDGER = { widget: { a: 'wikistead-docs/a.md', b: 'none: internal' } }

  it('a registered surface with no row is a violation (the new-feature case)', () => {
    const v = evaluateSurfaceDocs({ widget: ['a', 'b', 'c'] }, LEDGER)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ registry: 'widget', id: 'c' })
  })

  it('a row whose surface is gone is a violation (stale coverage claim)', () => {
    const v = evaluateSurfaceDocs({ widget: ['a'] }, LEDGER)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ registry: 'widget', id: 'b' })
  })

  it('an empty walk is a violation, not universal coverage (vacuity guard)', () => {
    const v = evaluateSurfaceDocs({ widget: [] }, LEDGER)
    expect(v).toHaveLength(1)
    expect(v[0]!.why).toContain('vacuity')
  })

  it('a registry the ledger does not know is a violation', () => {
    const v = evaluateSurfaceDocs({ gizmo: ['x'] }, LEDGER)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ registry: 'gizmo' })
  })

  it('a matching walk answers no violations (and none: rows count as covered)', () => {
    expect(evaluateSurfaceDocs({ widget: ['a', 'b'] }, LEDGER)).toEqual([])
  })
})

// doc↔code linkage evaluator (#139 / ADR-080). Verifies the MECHANISM with synthetic
// changed-file sets (independent of which repos are checked out): a designated code region
// changed without its docs page → violation; with its docs page → none; an unrelated
// change → none; glob matching (`**`, `*`) behaves. Also checks the real DOC_CODE_MAP is
// well-formed.
import { readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
// @ts-expect-error — .mjs script module, no types (pure JS CI helper)
import { evaluateDocLinks, evaluateSurfaceDocs, matchesAny, globToRegExp, DOC_CODE_MAP, checkLedgerPathsExist } from '../../../../scripts/doc-code-map.mjs'

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
  // 'scripts' too — measured in the CE build the day #734 landed: its map row names
  // scripts/env-catalog.mjs plus an EE generator, dev stayed green because the EE glob matched
  // under packages/, and the mirror (no EE) went red because the ONLY live glob pointed at a root
  // this walk never visited. The walk must cover every root the map may reference.
  for (const d of ['apps', 'packages', 'docs', 'scripts']) walk(join(repoRoot, d))
  return out
}

const MAP = [
  { label: 'levers', kind: 'generated', code: ['packages/entitlements/src/index.ts'], doc: 'docs/generated/plan-contents.md' },
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
    const v = evaluateDocLinks(['packages/entitlements/src/index.ts', 'docs/generated/plan-contents.md'], MAP)
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

// #1067 / ADR-244 §7 open point 4: evaluateSurfaceDocs and evaluateDocLinks both verify the LEDGER'S
// surface/id side against the registries — neither ever checks whether the PATH a row names actually
// exists on disk. Found live: SURFACE_DOCS['admin-surface'].scim named 'admin/scim.md' (never existed
// — the real file is 'admin/scim-provisioning.md'), and the DOC_CODE_MAP 'editor macros' entry named
// 'editor/macros.md' (never existed — the real page is 'reference/macro-notation.md'). Both were fixed
// alongside this check; these tests pin the NEW function with synthetic maps, not the real ledger (the
// real ledger's existence is exercised at the bottom of this file, against the real docs-site tree).
describe('checkLedgerPathsExist (#1067, ADR-244 §7 open point 4)', () => {
  const exists = (real: Set<string>) => (p: string) => real.has(p)

  it('a docCodeMap entry naming a page that does not exist is a violation', () => {
    const map = [{ label: 'widget', kind: 'authored', code: ['x/**'], doc: 'wikistead-docs/src/content/docs/widget.md' }]
    const { scanned, violations } = checkLedgerPathsExist(exists(new Set()), { docCodeMap: map, surfaceDocs: {} })
    expect(scanned).toBe(1)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ where: 'widget', path: 'docs-site/src/content/docs/widget.md' })
  })

  it('a surfaceDocs row naming a page that DOES exist is not a violation', () => {
    const surfaceDocs = { 'admin-surface': { widget: 'wikistead-docs/src/content/docs/widget.md' } }
    const { scanned, violations } = checkLedgerPathsExist(exists(new Set(['docs-site/src/content/docs/widget.md'])), { docCodeMap: [], surfaceDocs })
    expect(scanned).toBe(1)
    expect(violations).toEqual([])
  })

  it('`none: <reason>` rows are not paths — never scanned, never a violation', () => {
    const surfaceDocs = { 'admin-surface': { widget: 'none: no dedicated surface' } }
    const { scanned, violations } = checkLedgerPathsExist(exists(new Set()), { docCodeMap: [], surfaceDocs })
    expect(scanned).toBe(0)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.why).toContain('walk itself is likely broken')
  })

  it('a path already relative to this repo (not wikistead-docs/-prefixed) is checked as-is, unmapped', () => {
    const map = [{ label: 'levers', kind: 'generated', code: ['x/**'], doc: 'docs/generated/plan-contents.md' }]
    const { violations } = checkLedgerPathsExist(exists(new Set(['docs/generated/plan-contents.md'])), { docCodeMap: map, surfaceDocs: {} })
    expect(violations).toEqual([])
  })

  // ⚠️ break-check: prove the whole REAL ledger is clean now, not vacuously (an empty map would also
  // report zero violations) — scanned must be a real, non-trivial count.
  it('the REAL SURFACE_DOCS + DOC_CODE_MAP ledger has zero dangling paths against the real docs-site tree', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
    const { scanned, violations } = checkLedgerPathsExist((p: string) => {
      try { statSync(join(repoRoot, p)); return true } catch { return false }
    })
    expect(scanned, 'zero scanned is a failure — the walk itself is broken').toBeGreaterThan(20)
    expect(violations).toEqual([])
  })
})

// ── #865: the git adapter, run as a process against a real repository ───────────────────────────
//
// Everything above measures the pure evaluator with synthetic file lists. The defect this section
// exists for lived in the OTHER half: `check-doc-links.mjs` decides which files changed by asking
// git, and decides what `--strict` may fail on. Neither had ever been executed by a test.
//
// What that cost: a binding pointed at a page in the docs repository, which this repo's diff can
// never contain, so an armed run went red and stayed red — while a fast-forward push, whose diff is
// empty, passed the same gate having checked nothing. Both are properties of the adapter.
//
// A real temporary repository is used rather than a mock of git: the thing under test IS the
// conversation with git (`git diff --name-only <base>...HEAD`), and a mock of it would agree with
// whatever the script already does.
describe('#865 the git adapter of check-doc-links', () => {
  const script = join(repoRoot, 'scripts/check-doc-links.mjs')

  /** A throwaway repo with one commit per state, so `HEAD~1...HEAD` is a real diff. */
  function repoWithChange(files: Record<string, string>, changed: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'doclinks-'))
    const run = (cmd: string) => execFileSync('bash', ['-c', cmd], { cwd: dir, stdio: 'pipe' })
    run('git init -q && git config user.email t@t && git config user.name t')
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(p)), { recursive: true })
      writeFileSync(join(dir, p), body)
    }
    run('git add -A && git commit -qm base')
    for (const [p, body] of Object.entries(changed)) {
      mkdirSync(join(dir, dirname(p)), { recursive: true })
      writeFileSync(join(dir, p), body)
    }
    run('git add -A && git commit -qm change')
    return dir
  }

  function runCheck(dir: string, args: string[] = []): { code: number; out: string } {
    // BOTH streams: the script prints its refusals on stderr and its "OK" on stdout, so a helper
    // that reads only what execFileSync returns sees an empty string on every warning — measured
    // while writing this, and it looked exactly like "the check found nothing".
    const r = spawnSync('node', [script, ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, DOC_LINK_BASE: 'HEAD~1' },
    })
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }

  it('reads the diff from git and refuses a bound change whose page lives HERE', () => {
    // `apps/server/src/routes/**` is bound to docs/api-reference.md — a page in this repository,
    // so the violation is fixable in the same commit and --strict must fail on it.
    const dir = repoWithChange(
      { 'apps/server/src/routes/x.ts': 'a\n', 'docs/api-reference.md': 'doc\n' },
      { 'apps/server/src/routes/x.ts': 'b\n' },
    )
    const { code, out } = runCheck(dir, ['--strict'])
    expect(out, 'the adapter named the region it read from git').toContain('HTTP API routes')
    expect(code, 'a page in this repo is fixable, so strict fails').toBe(1)
  })

  it('and passes when the same commit moves that page', () => {
    const dir = repoWithChange(
      { 'apps/server/src/routes/x.ts': 'a\n', 'docs/api-reference.md': 'doc\n' },
      { 'apps/server/src/routes/x.ts': 'b\n', 'docs/api-reference.md': 'doc updated\n' },
    )
    expect(runCheck(dir, ['--strict']).code, 'the green path exists').toBe(0)
  })

  it('a page in the docs repo is a warning here, never a red with no way out', () => {
    // The shape #865 was filed for: with no docs checkout beside us, an authored page there cannot
    // be moved by this diff, so failing on it would leave a contributor with no green path.
    const dir = repoWithChange(
      { 'apps/web/src/settings/AdminBillingTab.tsx': 'a\n' },
      { 'apps/web/src/settings/AdminBillingTab.tsx': 'b\n' },
    )
    const { code, out } = runCheck(dir, ['--strict'])
    expect(out).toContain('admin console')
    expect(out, 'it says why it is only a warning').toContain('warn')
    expect(code).toBe(0)
  })

  it('an empty diff is not a pass — it is nothing measured, and the run says so', () => {
    // A fast-forward push has no diff against its own parent. The check cannot see a violation, so it
    // passes; #877 is that it used to pass with the SAME sentence as a run that judged something, and
    // the fast-forward path always takes this branch — the reassuring line appeared most often exactly
    // where nothing had been checked. Asserting the word OK, as this test first did, could not tell
    // the two apart: it named a property the run did not have.
    const dir = repoWithChange({ 'README.md': 'a\n' }, { 'README.md': 'a\n', 'unrelated.txt': 'x\n' })
    const { code, out } = runCheck(dir, ['--strict'])
    expect(code).toBe(0)
    expect(out, 'the run says the diff judged no binding').toContain('NOTHING MEASURED')
    expect(out, 'and how many there were to judge').toMatch(/touched none of the \d+ binding\(s\)/)
  })

  it('and a run that DID judge a binding says a different thing', () => {
    // The other half, and the one that makes the assertion above worth having: without it, printing
    // "NOTHING MEASURED" unconditionally would pass. Two greens, two sentences.
    const dir = repoWithChange(
      { 'apps/server/src/routes/x.ts': 'a\n', 'docs/api-reference.md': 'doc\n' },
      { 'apps/server/src/routes/x.ts': 'b\n', 'docs/api-reference.md': 'doc updated\n' },
    )
    const { code, out } = runCheck(dir, ['--strict'])
    expect(code).toBe(0)
    expect(out, 'it counts what it judged').toMatch(/\d+ of \d+ binding\(s\) judged/)
    expect(out, 'and does not claim the empty-diff shape').not.toContain('NOTHING MEASURED')
  })

  // #1067: these throwaway repos have neither `wikistead-docs/` nor `docs-site/` — the new ledger
  // path-existence check must read as skipped here, not fail every real ledger row as "dangling"
  // because the temp repo obviously does not contain any of them.
  it('the ledger path check reads as skipped (not failed) when docs-site/ is absent, as in every temp repo here', () => {
    const dir = repoWithChange({ 'README.md': 'a\n' }, { 'README.md': 'a\n', 'unrelated.txt': 'x\n' })
    const { code, out } = runCheck(dir, ['--strict'])
    expect(code).toBe(0)
    expect(out, 'says skipped, not a scanned-and-clean claim it cannot back up here').toContain('skipped')
  })
})

// #1173: scripts/publish-site.mjs drops the EE-only surface from the public docs snapshot — every
// EE-badge page, environment-variables-ee.md, and plan-contents.md's Edition column. That layer is
// vacuously green if the real content it matches against ever drifts to zero (a rename, a moved file,
// a frontmatter shape change), since "0 removed" and "10 removed" both print the same shape of line.
// This pin measures the REAL docs-site tree with the filter's own match logic and requires a
// non-trivial count, so a drift to zero is red here instead of silently shipping every EE page to the
// public site.
//
// ⚠️ Gated on the overlay being HERE (doc-code-links.test.ts's own convention): docs-site/ is a
// separate repository that lives beside some checkouts and not others, so a checkout without it prints
// "skipped" rather than failing on paths that were never going to exist.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const docsSiteHere = (() => {
  try { return statSync(join(repoRoot, 'docs-site')).isDirectory() } catch { return false }
})()

describe('#1173: the EE-only docs surface is non-trivial (guards the filter layer against drift)', () => {
  if (!docsSiteHere) {
    it.skip('skipped (no docs-site/ checkout here)', () => {})
    return
  }

  const docsRoot = join(repoRoot, 'docs-site/src/content/docs')

  it('counts a real, non-zero number of EE-badge pages — same match as publish-site.mjs', () => {
    let count = 0
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.mdx?$/.test(e)) continue
        const fm = readFileSync(p, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
        if (/text:\s*EE/.test(fm)) count++
      }
    }
    walk(docsRoot)
    expect(count, 'zero EE-badge pages means the filter layer would silently do nothing').toBeGreaterThan(0)
  })

  it('environment-variables-ee.md exists at the path publish-site.mjs removes', () => {
    expect(existsSync(join(docsRoot, 'reference/environment-variables-ee.md'))).toBe(true)
  })

  it('plan-contents.md has a real Edition column with at least one EE row', () => {
    const src = readFileSync(join(docsRoot, 'reference/plan-contents.md'), 'utf8')
    const header = src.split('\n').find((l) => l.startsWith('| Feature'))
    expect(header, 'the Edition column header still exists to be dropped').toContain('| Edition |')
    const eeRows = [...src.matchAll(/^\|.*\|\s*EE\s*\|/gm)].length
    expect(eeRows, 'zero EE rows means the Edition-column drop would touch nothing worth pinning').toBeGreaterThan(0)
  })
})

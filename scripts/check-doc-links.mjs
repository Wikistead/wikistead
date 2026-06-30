#!/usr/bin/env node
// CI doc↔code linkage check (#139 / ADR-080). Flags a PR that changed a designated code
// region without updating its bound docs page (DOC_CODE_MAP). The pure evaluator lives in
// doc-code-map.mjs; this is the git adapter.
//
//   node scripts/check-doc-links.mjs            → warn only (local default)
//   node scripts/check-doc-links.mjs --strict   → exit 1 on a violation (CI)
//
// Changed files come from `git diff --name-only <base>...HEAD`. The base is
// DOC_LINK_BASE (env) or `origin/main`, falling back to HEAD~1 for a local run. In the
// combined CI checkout (app + wikistead-docs), authored-page changes are visible too, so
// 'authored' entries bind correctly; locally those entries typically can't be evaluated
// (the docs repo isn't present), so the local default is warn-only.
import { execSync } from 'node:child_process'
import { evaluateDocLinks } from './doc-code-map.mjs'

const strict = process.argv.includes('--strict')

function changedFiles() {
  const base = process.env.DOC_LINK_BASE || 'origin/main'
  const tryDiff = (ref) => {
    try {
      const out = execSync(`git diff --name-only ${ref}...HEAD`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return out.split('\n').map((s) => s.trim()).filter(Boolean)
    } catch {
      return null
    }
  }
  return tryDiff(base) ?? tryDiff('HEAD~1') ?? []
}

const files = changedFiles()
const violations = evaluateDocLinks(files)

if (violations.length === 0) {
  console.log('OK: doc↔code linkage satisfied (no designated code region changed without its docs page).')
  process.exit(0)
}

for (const v of violations) {
  const where = v.kind === 'generated' ? 'run `pnpm docs:gen` and commit the result' : `update ${v.doc} (wikistead-docs)`
  console.error(`doc↔code: "${v.label}" code changed without its docs page → ${where}`)
  for (const f of v.changedCode) console.error(`    changed: ${f}`)
}
console.error(`\n${violations.length} doc↔code linkage issue(s). See ADR-080 (doc↔code linkage).`)
process.exit(strict ? 1 : 0)

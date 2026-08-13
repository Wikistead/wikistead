#!/usr/bin/env node
// CI doc↔code linkage check (#139 / ADR-080). Flags a PR that changed a designated code
// region without updating its bound docs page (DOC_CODE_MAP). The pure evaluator lives in
// doc-code-map.mjs; this is the git adapter.
//
//   node scripts/check-doc-links.mjs            → warn only (local default)
//   node scripts/check-doc-links.mjs --strict   → exit 1 on an ENFORCEABLE violation (CI)
//
// #697 / ADR-225 §4.1 — what --strict can honestly enforce differs by entry kind:
//   'generated' pages live in THIS repo, so their violation is always enforceable → fail.
//   'authored' pages live in the docs repo; the binding is only satisfiable where the doc
//   side appears in the SAME diff — the combined CI checkout (`wikistead-docs/`). The local
//   `docs-site/` overlay is its own git repository, invisible to this repo's diff, so its
//   presence must NOT arm enforcement (measured on #693: the first arming made every mapped
//   change red with no green path in a bootstrapped dev checkout). Elsewhere authored
//   violations stay loud warnings. This asymmetry is stated in ADR-225.
//
// Changed files come from `git diff --name-only <base>...HEAD`. The base is
// DOC_LINK_BASE (env) or `origin/main`, falling back to HEAD~1 for a local run.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { evaluateDocLinks } from './doc-code-map.mjs'

const strict = process.argv.includes('--strict')
const docsCheckoutPresent = existsSync('wikistead-docs')

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

const enforceable = violations.filter((v) => v.kind === 'generated' || docsCheckoutPresent)
const warnOnly = violations.filter((v) => !enforceable.includes(v))

for (const v of violations) {
  const where = v.kind === 'generated' ? 'run `pnpm docs:gen` and commit the result' : `update ${v.doc} (wikistead-docs)`
  const hard = enforceable.includes(v)
  console.error(`doc↔code${hard ? '' : ' (warn — no docs checkout here)'}: "${v.label}" code changed without its docs page → ${where}`)
  for (const f of v.changedCode) console.error(`    changed: ${f}`)
}
console.error(`\n${violations.length} doc↔code linkage issue(s) (${enforceable.length} enforceable, ${warnOnly.length} warn). See ADR-080 / ADR-225 §4.1.`)
process.exit(strict && enforceable.length > 0 ? 1 : 0)

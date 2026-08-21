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
import { evaluateDocLinks, docLinkCoverage } from './doc-code-map.mjs'

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
const { bindings, judged, changedFiles: changedCount } = docLinkCoverage(files)

// #877: say which green this is. A run that judged nothing and a run that judged three bindings and
// found them all satisfied printed the SAME sentence, and the fast-forward path always takes the
// first one — so the reassuring line appeared most often exactly where nothing had been checked.
if (violations.length === 0) {
  console.log(
    judged === 0
      ? `OK: doc↔code linkage — NOTHING MEASURED: ${changedCount} changed file(s) touched none of the ${bindings} binding(s). ` +
        'A fast-forward push has no diff against its own parent, so this is a green that checked nothing.'
      : `OK: doc↔code linkage satisfied — ${judged} of ${bindings} binding(s) judged, every one moved its page ` +
        `(${changedCount} changed file(s)).`,
  )
  process.exit(0)
}

// #865: what `--strict` may enforce is decided by WHERE THE PAGE IS, not by the entry's kind. A
// violation is only fixable when the doc side can move in the same diff this check reads: pages in
// this repository always can (generated ones, and the authored canon like docs/api-reference.md);
// pages in the docs repository can only when its checkout is here beside us. Keying on `kind` meant
// an authored page that lives HERE was reported as a warning nobody had to act on.
const inThisRepo = (doc) => !doc.startsWith('wikistead-docs/')
const enforceable = violations.filter((v) => inThisRepo(v.doc) || docsCheckoutPresent)
const warnOnly = violations.filter((v) => !enforceable.includes(v))

for (const v of violations) {
  const where = v.kind === 'generated'
    ? 'run `pnpm docs:gen` and commit the result'
    : inThisRepo(v.doc) ? `update ${v.doc} in this commit` : `update ${v.doc} (wikistead-docs)`
  const hard = enforceable.includes(v)
  console.error(`doc↔code${hard ? '' : ' (warn — no docs checkout here)'}: "${v.label}" code changed without its docs page → ${where}`)
  for (const f of v.changedCode) console.error(`    changed: ${f}`)
}
console.error(`\n${violations.length} doc↔code linkage issue(s) of ${judged} binding(s) judged (${enforceable.length} enforceable, ${warnOnly.length} warn). See ADR-080 / ADR-225 §4.1.`)
process.exit(strict && enforceable.length > 0 ? 1 : 0)

#!/usr/bin/env node
// #138: the version DERIVATION is measured, not asserted from the config's text.
//
// The defect this pins: releaseRules are first-match-wins, so a `feat` row ABOVE the breaking rule
// silently swallowed BREAKING CHANGE footers — every breaking release would have shipped as minor,
// forever, while the config's own comment claimed otherwise. A string-match pin would have stayed
// green through that; this runs semantic-release --dry-run against synthetic histories built from
// the REAL release.config.mjs and checks what version actually comes out.
//
// Cases (acceptance, verbatim): BREAKING footer on each of feat/fix/perf must derive a
// MAJOR — measured at BOTH 0.x and 1.x, because at 0.x a swallowed major still lands on 1.0.0 and
// the lie is invisible. Plus the plain-type sanity rows (feat→minor, fix→patch, chore→nothing).
//
// Technique (recorded on the ticket): a scratch git repo with a local bare `origin` satisfies
// semantic-release's remote requirement; node_modules is symlinked from this repo so the plugins
// resolve. The upstream is never touched.
import { mkdtempSync, rmSync, writeFileSync, cpSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function sh(cwd, cmd, args, env = {}) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
}

/** Build a scratch repo at `baseTag`, add one commit with `subject` (+ optional footer), dry-run. */
function derive(baseTag, subject, footer) {
  const dir = mkdtempSync(join(tmpdir(), 'rel138-'))
  try {
    const origin = join(dir, 'origin.git')
    const work = join(dir, 'work')
    sh(dir, 'git', ['init', '-q', '--bare', origin])
    sh(dir, 'git', ['clone', '-q', origin, work])
    sh(work, 'git', ['config', 'user.email', 't@t'])
    sh(work, 'git', ['config', 'user.name', 't'])
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'rel138', version: '0.0.0', private: true }, null, 2))
    cpSync(join(repoRoot, 'release.config.mjs'), join(work, 'release.config.mjs'))
    symlinkSync(join(repoRoot, 'node_modules'), join(work, 'node_modules'))
    sh(work, 'git', ['add', 'package.json', 'release.config.mjs'])
    sh(work, 'git', ['commit', '-qm', 'chore: scaffold'])
    sh(work, 'git', ['tag', baseTag])
    sh(work, 'git', ['push', '-q', 'origin', 'master', '--tags'])
    writeFileSync(join(work, 'change.txt'), subject)
    sh(work, 'git', ['add', 'change.txt'])
    sh(work, 'git', ['commit', '-qm', footer ? `${subject}\n\n${footer}` : subject])
    sh(work, 'git', ['push', '-q', 'origin', 'master'])
    let out = ''
    try {
      out = sh(work, join(repoRoot, 'node_modules/.bin/semantic-release'), ['--dry-run', '--no-ci'], { GITHUB_ACTIONS: '' })
    } catch (e) {
      out = String(e.stdout ?? '') + String(e.stderr ?? '')
    }
    const m = out.match(/next release version is (\S+)/)
    if (m) return m[1]
    if (/no relevant changes|There are no relevant changes/i.test(out)) return null
    throw new Error(`could not read the derivation from the dry-run output:\n${out.slice(-800)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CASES = [
  // The rejection's core: a breaking footer majors, for EVERY releasing type, at BOTH bases.
  { base: 'v1.0.0', subject: 'feat: a breaking thing', footer: 'BREAKING CHANGE: the old way is gone', want: '2.0.0' },
  { base: 'v1.0.0', subject: 'fix: a breaking fix', footer: 'BREAKING CHANGE: the old way is gone', want: '2.0.0' },
  { base: 'v1.0.0', subject: 'perf: a breaking speedup', footer: 'BREAKING CHANGE: the old way is gone', want: '2.0.0' },
  { base: 'v0.1.0', subject: 'feat: a breaking thing', footer: 'BREAKING CHANGE: the old way is gone', want: '1.0.0' },
  { base: 'v0.1.0', subject: 'fix: a breaking fix', footer: 'BREAKING CHANGE: the old way is gone', want: '1.0.0' },
  { base: 'v0.1.0', subject: 'perf: a breaking speedup', footer: 'BREAKING CHANGE: the old way is gone', want: '1.0.0' },
  // Sanity: the plain vocabulary still means what the project design notes says.
  { base: 'v1.0.0', subject: 'feat: an ordinary thing', want: '1.1.0' },
  { base: 'v1.0.0', subject: 'fix: an ordinary fix', want: '1.0.1' },
  { base: 'v1.0.0', subject: 'chore: nothing releasable', want: null },
]

let failed = false
for (const c of CASES) {
  const got = derive(c.base, c.subject, c.footer)
  const label = `${c.base} + "${c.subject}"${c.footer ? ' + BREAKING' : ''}`
  if (got !== c.want) {
    failed = true
    console.error(`FAIL ${label} → derived ${got ?? 'no release'}, expected ${c.want ?? 'no release'}`)
  } else {
    console.log(`ok   ${label} → ${got ?? 'no release'}`)
  }
}
if (failed) {
  console.error('\ncheck-release-derivation: the config no longer derives what the project design notes promises (#138).')
  process.exit(1)
}
console.log('check-release-derivation OK — breaking majors on all three types at 0.x and 1.x; the plain vocabulary is intact.')

#!/usr/bin/env node
// #138 prep / the project design notes (" / / "): commit subjects are Conventional Commits,
// and the TYPE comes from the list the project design notes fixes.
//
// WHY THIS EXISTS BEFORE semantic-release DOES. Introducing semantic-release is deliberately held until
// the first release (the project design notes's `TODO(release)`), and this does not introduce it. What it does is make
// the eventual introduction safe: semantic-release DERIVES the version from these subjects, so a type it
// does not recognise is not a lint failure later — it is a release that bumps the wrong number, or does
// not happen at all, over a history nobody can retype.
//
// Measured when written: 200 commits, and exactly one used a type outside the list — `ci(deploy):`,
// written by the session that added this file, two commits earlier. It was already merged, so it stays
// rewriting a shared branch to fix a subject line would cost every parallel worktree a divergence, which
// is a real problem traded for a cosmetic one. It is recorded here instead, and the guard is why there is
// not a second.
//
// Run: pnpm lint:commit-types [<base>] (defaults to comparing HEAD against origin/master or master)
import { execFileSync } from 'node:child_process'

// the project design notes: `type(scope): subject`, type ∈ feat | fix | chore | docs | refactor | test | build | perf.
// Written out rather than "any lowercase word" — a fixed vocabulary is the point, since the release
// tooling maps each type to a version bump and an unknown one maps to nothing.
const TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'build', 'perf']
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([^)]+\\))?!?: .+`)

/** Commits on HEAD that are not on `base` — this branch's own work, not the history behind it. */
function commitsToCheck(base) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  let range
  try {
    git('rev-parse', '--verify', '--quiet', base)
    range = `${base}..HEAD`
  } catch {
    // No base to compare with (a fresh clone, or a detached CI checkout): fall back to the last commit,
    // which is the one the author can still fix. Checking the whole history would fail on the past.
    range = '-1'
  }
  const out = range === '-1'
    ? git('log', '-1', '--pretty=%H%x00%s')
    : git('log', range, '--pretty=%H%x00%s')
  return out ? out.split('\n').map((l) => { const [sha, subject] = l.split('\0'); return { sha, subject } }) : []
}

const base = process.argv[2] ?? (() => {
  for (const candidate of ['origin/master', 'master', 'origin/main', 'main']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', candidate], { stdio: 'pipe' })
      return candidate
    } catch { /* try the next */ }
  }
  return 'HEAD~1'
})()

const bad = commitsToCheck(base).filter(({ subject }) => !SUBJECT.test(subject))
if (bad.length > 0) {
  for (const { sha, subject } of bad) console.error(`FAIL: ${sha.slice(0, 8)} ${subject}`)
  console.error('')
  console.error(`A commit subject is \`type(scope): subject\`, type one of: ${TYPES.join(' | ')}.`)
  console.error('The list is fixed because the release tooling maps each type to a version bump —')
  console.error('an unrecognised one maps to nothing, and the mistake surfaces at release time.')
  process.exit(1)
}

console.log(`OK: every commit since ${base} names a known type`)

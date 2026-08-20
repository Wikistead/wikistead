// #796: what "this suite is inside the isolated stack" MEANS, written once.
//
// Three packages run integration suites (apps/server, packages/ee-server, apps/collab) and all three
// have to be pointed at the isolated server-test stack rather than at the developer's own database.
// The family's whole history is copies drifting apart: #178 mirrored apps/server's vitest config into
// the EE package, #268/#269 moved the original onto the isolated stack, and the copy stayed on the dev
// one for two months. #789 then found the same shape a third time in collab.
//
// So the ASSERTIONS live here and the pins call them. A pin per package is still needed (each suite
// has to run its own), but what they assert is one definition — copying a call is not the same as
// copying a rule that can then be edited on one side only.
// ⚠️ Plain `.mjs` on purpose: the packages that import it have their own `rootDir`, and a TS file
// outside it is a typecheck error in every one of them (measured). Same convention as the pins that
// import `scripts/*.mjs`.
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** Reads a single `KEY=value` out of an env FILE — the dev environment we must NOT be talking to. */
export function envFileValue(root, file, key) {
  const p = resolve(root, file)
  if (!existsSync(p)) return null
  const line = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim() : null
}

/**
 * A fact carries: `what` (the failure a reader would otherwise get, in words), `actual` (the running
 * process's value) and `dev` (the developer's own value, or null on a machine that has no dev
 * environment at all — CI, a fresh clone — where there is nothing to be confused with).
 */
/**
 * What the RUNNING process says about the stack it is connected to.
 *
 * Asked of `process.env` rather than of the config file, because a comment saying "we load the
 * server-test env" is true on the day it is written and silently false afterwards — which is exactly
 * how this family's three bugs were born.
 *
 * Compared against the dev VALUES rather than against hard-coded URLs: every session runs its own
 * port offset, so a literal would be wrong for two developers out of three.
 */
export function isolatedStackFacts(root) {
  return {
    marker: process.env.WIKISTEAD_TEST_STACK,
    facts: [
      {
        what: 'the suite is connected to the developer\'s own database',
        actual: process.env.DATABASE_URL,
        dev: envFileValue(root, '.env', 'DATABASE_URL'),
      },
      {
        what: 'the suite is pointed at the shared dev permission store',
        actual: process.env.OPENFGA_STORE_ID,
        dev: envFileValue(root, '.env', 'OPENFGA_STORE_ID'),
      },
    ],
  }
}

/**
 * The RULE, once — not the facts but the verdict on them. `isolatedStackFacts` says what to look at;
 * this says what counts as wrong, and every pin calls it instead of restating it.
 *
 * #819: the three pins that existed each carried their own copy of the same dozen lines — an empty
 * definition is red, a machine with no dev environment is a declared skip, a missing value is a
 * finding rather than a skip, an equal value is the bug. A copy is a rule that can be edited on one
 * side only, which is how all three of this family's bugs were built, so the fourth package does not
 * get a fourth copy of it.
 *
 * Each problem names BOTH sides with their real values. A reader of a red run has to see which url
 * this process reached and which one it was confused with; without them the finding is just an
 * assertion failing, and the reader goes looking in the wrong place.
 */
export function isolatedStackVerdict(root) {
  const { marker, facts } = isolatedStackFacts(root)
  // Reported as its own flag rather than as a quiet pass: an empty definition would make every loop
  // below run zero times, and a walk that compared nothing is the shape of every vacuous green this
  // repository has had to fix.
  const definitionEmpty = facts.length < 2
  const comparable = facts.filter((f) => f.dev)
  const problems = []
  for (const f of comparable) {
    if (!f.actual) {
      // Not a skip: the isolated stack is supposed to have handed this process the variable, so a
      // suite running without it is missing the very thing being asserted about.
      problems.push(`${f.what} — this process has no value for it at all (the dev environment has: ${f.dev})`)
    } else if (f.actual === f.dev) {
      problems.push(`${f.what} — this process reached: ${f.actual} / the developer's own: ${f.dev}`)
    }
  }
  return { marker, definitionEmpty, compared: comparable.length, problems }
}

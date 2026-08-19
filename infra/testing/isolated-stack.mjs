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

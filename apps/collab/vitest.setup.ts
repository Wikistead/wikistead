import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Which database and permission store the collab suite talks to.
//
// It used to be "the dev one if this machine has a `.env`, the isolated stack otherwise", which
// meant every developer machine ran these tests against the shared dev stack while CI ran them
// against the isolated one — the two halves of the same suite watching different data.
//
// #789 (the second of the family #787 found): what that cost, measured twice on the same day.
// A session legitimately re-created the shared dev FGA store, and eight collab files went red with
// `authorization_model_not_found`; earlier, #756caught four of them red while the dev stack
// was empty. Nothing was wrong with the code either time. The suite was simply watching somebody
// else's stack, and the failure reads as a product bug.
//
// So the order is now unconditional, and it is the same one `apps/server` and `packages/ee-server`
// use: `.env.server-test.local` FIRST because it carries the bootstrapped store/model ids and this
// session's port offset, then the base file — `process.loadEnvFile` never overrides a variable that
// is already set, so first wins.
//
// ⚠️ THE PUBLIC CI IS WHY THE OLD ORDER EXISTED, and it keeps working: `.env` is gitignored and a
// runner has none, so the old code fell through to exactly these two files. Measured in the CE build:
// `.env.server-test` is tracked and published (`.env.server-test.local` is ignored and is not), and
// the workflow runs `pnpm setup:server-test` before `pnpm test`. Removing the `.env` branch changes
// nothing there — it removes the branch only a developer machine ever took.
//
// The valve below is #269's, which this package never had. These tests write tenants, spaces and
// permission tuples; running them against the dev stack is how the owner's data gets edited by a
// test run. A missing marker is a refusal, not a warning.
export function setup() {
  const root = resolve(import.meta.dirname, '../..')
  for (const f of ['.env.server-test.local', '.env.server-test']) {
    const p = resolve(root, f)
    if (existsSync(p)) (process as any).loadEnvFile(p)
  }
  if (process.env.WIKISTEAD_TEST_STACK !== 'server-test') {
    throw new Error(
      'Refusing to run the collab test suite outside the isolated server-test stack ' +
        '(WIKISTEAD_TEST_STACK != "server-test"). Run `pnpm setup:server-test` first — these tests ' +
        'write tenants, spaces and permission tuples, and must not touch the dev stack (#789, the #269 valve).',
    )
  }
}

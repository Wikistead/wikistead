import { defineConfig } from 'vitest/config'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Integration tests connect to real middleware (Postgres / OpenFGA / Meili / Valkey).
// #268: they run against the ISOLATED server-test stack (docker-compose.server-test.yml,
// `pnpm setup:server-test`), NOT the dev stack — so the destructive tests (billing.test
// wipes spaces, plan-freeze mutates members) never touch dev data.
//
// process.loadEnvFile is Node.js 20.12+ built-in and does NOT override an already-set var,
// so load .env.server-test.local (the bootstrapped FGA store/model ids) FIRST, then
// .env.server-test.
//
// #269 SAFETY VALVE: the server suite is DESTRUCTIVE (billing.test wipes spaces, the tenant/oidc
// tests mutate rows). It MUST run only against the isolated server-test stack, NEVER the dev DB —
// a recurring accident that wiped the user's dev data. .env.server-test sets WIKISTEAD_TEST_STACK;
// if it is not 'server-test' after loading (file deleted, never set up, or DATABASE_URL repointed at
// dev), we FAIL FAST with a setup hint rather than silently connecting to — and destroying — dev.
function loadEnv() {
  const root = resolve(import.meta.dirname, '../..')
  for (const f of ['.env.server-test.local', '.env.server-test']) {
    const p = resolve(root, f)
    if (existsSync(p)) (process as any).loadEnvFile(p)
  }
  if (process.env.WIKISTEAD_TEST_STACK !== 'server-test') {
    throw new Error(
      'Refusing to run the server test suite outside the isolated server-test stack ' +
        '(WIKISTEAD_TEST_STACK != "server-test"). Run `pnpm setup:server-test` first — the suite is ' +
        'destructive and must NOT touch the dev DB (#268/#269).',
    )
  }
}
loadEnv()

export default defineConfig({
  test: {
    // Integration tests share a single DB instance — run files sequentially
    // to prevent concurrent state interference (e.g., space count races).
    fileParallelism: false,
  },
})

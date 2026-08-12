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
  // #688: tests reach the EE package (the audit ledger) through an alias to its SOURCE rather than a
  // package.json dependency — ee-server depends on this package, so a dependency back would cycle
  // turbo's graph. Source, not dist: a stale dist here has bitten before, and vitest transforms the
  // TS the same either way. tsconfig.typecheck.json mirrors the alias for tsc.
  resolve: {
    alias: {
      '@wikistead-ee/server': resolve(import.meta.dirname, '../../packages/ee-server/src/index.ts'),
      // ⚠️ The EE SOURCE above imports '@wikistead/server/ee-host', which node resolution would take
      // to this package's DIST — a second module instance whose registrations (the audit sink, the
      // transparency projector) the source-compiled routes never see. Measured: every route-level
      // audit assertion read 0 rows while direct enqueues worked. One graph, one instance:
      '@wikistead/server/ee-host': resolve(import.meta.dirname, 'src/ee-host.ts'),
    },
  },
  test: {
    // Integration tests share a single DB instance — run files sequentially
    // to prevent concurrent state interference (e.g., space count races).
    fileParallelism: false,
    // #688: the suite tests the EE COMPOSITION's audit behaviour (ledger rows exist after audited
    // operations), so the EE audit sink + viewer mount register once for every file — the same
    // wiring main.ts does at the real composition root. See the setup file for why.
    // ⚠️ Conditional on the file EXISTING: the public tree carries neither the EE package nor this
    // setup (the filter's derived exclusion drops both), and a hard reference would kill the whole
    // remaining suite there at startup.
    setupFiles: existsSync(resolve(import.meta.dirname, 'src/__tests__/helpers/setup-ee-audit.ts'))
      ? ['./src/__tests__/helpers/setup-ee-audit.ts'] : [],
  },
})

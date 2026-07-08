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
// .env.server-test. If the isolated stack was never set up, fall back to the root .env
// (legacy behaviour) so a bare checkout still resolves *some* config and fails with a clear
// connection error pointing at setup:server-test rather than a cryptic missing-var crash.
function loadEnv() {
  const root = resolve(import.meta.dirname, '../..')
  const serverTest = ['.env.server-test.local', '.env.server-test'].map((f) => resolve(root, f))
  const files = serverTest.some((p) => existsSync(p)) ? serverTest : [resolve(root, '.env')]
  for (const p of files) if (existsSync(p)) (process as any).loadEnvFile(p)
}
loadEnv()

export default defineConfig({
  test: {
    // Integration tests share a single DB instance — run files sequentially
    // to prevent concurrent state interference (e.g., space count races).
    fileParallelism: false,
  },
})

import { defineConfig } from 'vitest/config'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Load root .env for integration tests that need DATABASE_ADMIN_URL / DATABASE_URL.
// process.loadEnvFile is Node.js 20.12+ built-in; does not override vars already set.
function loadEnv() {
  const p = resolve(import.meta.dirname, '../../.env')
  if (existsSync(p)) (process as any).loadEnvFile(p)
}
loadEnv()

export default defineConfig({
  test: {
    // Integration tests share a single DB instance — run files sequentially
    // to prevent concurrent state interference (e.g., space count races).
    fileParallelism: false,
  },
})

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Load root .env before tests run so DATABASE_ADMIN_URL / DATABASE_URL are available.
// process.loadEnvFile is available since Node.js 20.12; does nothing if file absent.
export function setup() {
  const root = resolve(import.meta.dirname, '../..')
  // Dev's .env, exactly as before. Without one (the public CI: .env is gitignored and the runner
  // has none), the server-test stack that `pnpm setup:server-test` just started is the database
  // these tests get — the .local file loads first so its per-stack ports win (loadEnvFile never
  // overrides what is already set). Measured on the public CI's first day: no .env meant the pool
  // dialled a bare localhost:5432 and every collab test died on ECONNREFUSED.
  const candidates = existsSync(resolve(root, '.env'))
    ? ['.env']
    : ['.env.server-test.local', '.env.server-test']
  for (const f of candidates) {
    const p = resolve(root, f)
    if (existsSync(p)) (process as any).loadEnvFile(p)
  }
}

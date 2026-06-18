import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Load root .env before tests run so DATABASE_ADMIN_URL / DATABASE_URL are available.
// process.loadEnvFile is available since Node.js 20.12; does nothing if file absent.
export function setup() {
  const envPath = resolve(import.meta.dirname, '../../.env')
  if (existsSync(envPath)) (process as any).loadEnvFile(envPath)
}

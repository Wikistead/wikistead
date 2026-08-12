// #690: what history published, production must refuse.
//
// The dev encryption key sits in the published test fixtures (.env.e2e / .env.server-test), and
// secret-crypto's boot assert checked only presence and length — pasting the published key into
// production would boot. Production now refuses the published values at startup; dev and the test
// stacks run on exactly those values by design.
//
// (The history side of #690 — the env-backup filter and its sweep — is pinned in
// env-history-belt-690.test.ts, which is dev-repo-only: it imports the filter script, and the filter
// script does not publish itself.)
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { assertNoPublishedSecretsInProduction, PUBLISHED_FIXTURE_SECRETS } from '../auth/secret-crypto.js'

const repoRoot = resolve(import.meta.dirname, '../../../..')
// The published fixture files themselves (mirrors carry all three at the repo root).
const FIXTURE_ENV_FILES = ['.env.example', '.env.e2e', '.env.server-test']

describe('#690 ②: production refuses published secrets; dev and the stacks still boot', () => {
  const publishedKey = PUBLISHED_FIXTURE_SECRETS['OIDC_SECRET_ENC_KEY']![0]!

  it('production + a published value → refuse, for every guarded variable', () => {
    for (const [name, values] of Object.entries(PUBLISHED_FIXTURE_SECRETS)) {
      for (const v of values) {
        expect(() => assertNoPublishedSecretsInProduction({ NODE_ENV: 'production', [name]: v } as NodeJS.ProcessEnv),
          `${name}=${v} booted production`).toThrowError(/published/)
      }
    }
  })

  it('production + a fresh key → boots (the refusal is the denylist, not the environment)', () => {
    const fresh = randomBytes(32).toString('base64')
    expect(() => assertNoPublishedSecretsInProduction(
      { NODE_ENV: 'production', OIDC_SECRET_ENC_KEY: fresh } as NodeJS.ProcessEnv)).not.toThrow()
  })

  it('dev/test + the published values → boots (the fixtures run on them by design)', () => {
    for (const nodeEnv of ['development', 'test', undefined]) {
      expect(() => assertNoPublishedSecretsInProduction(
        { NODE_ENV: nodeEnv, OIDC_SECRET_ENC_KEY: publishedKey } as NodeJS.ProcessEnv)).not.toThrow()
    }
  })

  it('the boot path actually calls the assert (a guard nobody calls guards nothing)', () => {
    const app = readFileSync(join(repoRoot, 'apps/server/src/app.ts'), 'utf8')
    expect(app).toContain('assertNoPublishedSecretsInProduction()')
  })
})

describe('#690 ③: the denylist is derived against the fixtures, not remembered', () => {
  it('every guarded variable value in the published fixture files is denylisted', () => {
    for (const fixture of FIXTURE_ENV_FILES) {
      const text = readFileSync(join(repoRoot, fixture), 'utf8')
      for (const [name, published] of Object.entries(PUBLISHED_FIXTURE_SECRETS)) {
        for (const line of text.split('\n')) {
          const m = new RegExp(`^${name}=(.+)$`).exec(line.trim())
          if (m && m[1]) {
            expect(published, `${fixture} publishes ${name}=${m[1]} but the production denylist does not know it`)
              .toContain(m[1])
          }
        }
      }
    }
  })
})

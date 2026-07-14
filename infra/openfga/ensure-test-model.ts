// #418: pre-test FGA model self-consistency guard for the ISOLATED server-test stack.
//
// The server test suite pins OPENFGA_MODEL_ID (fgaClient), and that pin lives in the worktree-local
// .env.server-test.local written by `pnpm setup:server-test`. When a rebase moves model.fga forward
// (parallel sessions land model changes frequently), the pinned model silently goes STALE and the
// suite fails in confusing, data-shaped ways (e.g. a view-derivation change making a private title
// vanish from a dictionary assertion). This guard runs at the head of `pnpm --filter @wikistead/server
// test` (inside the same flock): it compares the worktree's model.fga against the model the pin points
// at, and on ANY mismatch writes the current model (immutable, additive — other sessions' pinned model
// versions are untouched) and updates the local pin. Match → sub-second no-op.
//
// SAFETY: refuses to run outside the server-test stack (same #269 fail-fast class as vitest.config) —
// this must never rewrite the dev or prod env.
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenFgaClient } from '@openfga/sdk'
import { transformer } from '@openfga/syntax-transformer'

const dir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(dir, '../..')
const localEnvPath = join(repoRoot, '.env.server-test.local')

// Same order as apps/server/vitest.config.ts: local first (loadEnvFile never overrides a set var).
for (const f of ['.env.server-test.local', '.env.server-test']) {
  const p = join(repoRoot, f)
  if (existsSync(p)) (process as unknown as { loadEnvFile(p: string): void }).loadEnvFile(p)
}

if (process.env.WIKISTEAD_TEST_STACK !== 'server-test') {
  console.error(
    'ensure-test-model: refusing to run outside the isolated server-test stack ' +
      '(WIKISTEAD_TEST_STACK != "server-test"). Run `pnpm setup:server-test` first (#268/#269).',
  )
  process.exit(1)
}

const apiUrl = process.env.OPENFGA_API_URL ?? 'http://localhost:8080'
const storeId = process.env.OPENFGA_STORE_ID
const pinnedModelId = process.env.OPENFGA_MODEL_ID
if (!storeId) {
  console.error('ensure-test-model: OPENFGA_STORE_ID missing — run `pnpm setup:server-test`.')
  process.exit(1)
}

// Canonicalize for comparison: sort object keys recursively; drop the server-added id field, null/
// undefined, and EMPTY values — arrays, objects, and strings (the read-back fills defaults the DSL
// transform omits: `generic_types: []`, `module: ""`, `condition: ""`) — all meaning "absent".
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) {
    const arr = v.map(canonical).filter((x) => x !== undefined)
    return arr.length ? arr : undefined
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (k === 'id') continue
      const val = canonical((v as Record<string, unknown>)[k])
      if (val === undefined || val === null) continue
      out[k] = val
    }
    return Object.keys(out).length ? out : undefined
  }
  if (v === '') return undefined
  return v ?? undefined
}

;(async () => {
  const dsl = await readFile(join(dir, 'model.fga'), 'utf8')
  const wanted = transformer.transformDSLToJSONObject(dsl)
  const fga = new OpenFgaClient({ apiUrl, storeId })

  if (pinnedModelId) {
    try {
      const { authorization_model } = await fga.readAuthorizationModel({ authorizationModelId: pinnedModelId })
      if (
        authorization_model &&
        JSON.stringify(canonical(authorization_model)) === JSON.stringify(canonical(wanted))
      ) {
        console.error(`ensure-test-model: pinned model ${pinnedModelId} matches model.fga — ok`)
        return
      }
      console.error(`ensure-test-model: pinned model ${pinnedModelId} is STALE (model.fga moved) — rewriting`)
    } catch {
      console.error(`ensure-test-model: pinned model ${pinnedModelId} unreadable (store recreated?) — rewriting`)
    }
  } else {
    console.error('ensure-test-model: no OPENFGA_MODEL_ID pinned — writing the current model')
  }

  const { authorization_model_id } = await fga.writeAuthorizationModel(wanted as never)
  console.error(`ensure-test-model: wrote model ${authorization_model_id}`)

  // Update (or add) the pin in the worktree-local env file. Never touches .env / .env.server-test.
  let env = existsSync(localEnvPath) ? await readFile(localEnvPath, 'utf8') : ''
  if (/^OPENFGA_MODEL_ID=.*$/m.test(env)) {
    env = env.replace(/^OPENFGA_MODEL_ID=.*$/m, `OPENFGA_MODEL_ID=${authorization_model_id}`)
  } else {
    env += `${env.endsWith('\n') || env === '' ? '' : '\n'}OPENFGA_MODEL_ID=${authorization_model_id}\n`
  }
  await writeFile(localEnvPath, env)
  console.error(`ensure-test-model: updated ${localEnvPath}`)
})().catch((e) => {
  console.error('ensure-test-model failed:', e)
  process.exit(1)
})

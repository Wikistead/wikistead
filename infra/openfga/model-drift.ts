// #433 (generalizing #418): shared FGA model-drift healing for the ISOLATED test stacks.
//
// Parallel sessions share one compose stack per suite (server-test, e2e) but pin
// OPENFGA_STORE_ID / OPENFGA_MODEL_ID in worktree-local env files. Two drift shapes
// turn that into confusing false-red suites:
//   - MODEL drift: another worktree bootstrapped its model.fga → your pinned model is
//     an older shape and checks fail in data-shaped ways.
//   - STORE drift: the stack's FGA volume was recreated → your pinned store id is dead
//     and every check dies instantly.
// The heal runs at the head of each suite command (inside the same flock, so nothing
// can re-bootstrap mid-run): re-point the store pin at the live store (found by name),
// then compare the worktree's model.fga against the pinned model and write the current
// model on any mismatch (immutable + additive — other sessions' pins are untouched).
// Match → sub-second no-op.
//
// SAFETY: refuses to run unless WIKISTEAD_TEST_STACK matches the expected stack (the
// #269 fail-fast class) — this must never rewrite the dev or prod env.
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenFgaClient } from '@openfga/sdk'
import { transformer } from '@openfga/syntax-transformer'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Canonicalize for comparison: sort object keys recursively; drop the server-added id
// field, null/undefined, and EMPTY values — arrays, objects, and strings (the read-back
// fills defaults the DSL transform omits: `generic_types: []`, `module: ""`,
// `condition: ""`) — all meaning "absent".
// KEEP IN SYNC with apps/server/src/openfga-guard.ts (the dev startup guard carries its
// own copy — the server can't import across the infra/ boundary).
export function canonicalModel(v: unknown): unknown {
  if (Array.isArray(v)) {
    const arr = v.map(canonicalModel).filter((x) => x !== undefined)
    return arr.length ? arr : undefined
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (k === 'id') continue
      const val = canonicalModel((v as Record<string, unknown>)[k])
      if (val === undefined || val === null) continue
      out[k] = val
    }
    return Object.keys(out).length ? out : undefined
  }
  if (v === '') return undefined
  return v ?? undefined
}

// The store name every stack's bootstrap.ts creates/reuses (one FGA instance per stack,
// so the fixed name is unambiguous within a stack).
const STORE_NAME = 'wikistead'
// Any valid ULID works for store-listing calls (the client just validates the format).
const DUMMY_STORE = '01H5M3YCPQ3ZHWT1J8RYATM4WN'

export interface EnsureStackOpts {
  label: string // log prefix, e.g. 'ensure-test-model'
  stack: string // required WIKISTEAD_TEST_STACK value
  envFiles: string[] // repo-root-relative, local first (loadEnvFile never overrides a set var)
  localEnvFile: string // the worktree-local pin file this heal may rewrite
  setupCmd: string // full re-setup command for the unhealable case (no live store = no seeds)
}

function upsertEnvVar(env: string, key: string, value: string): string {
  const line = `${key}=${value}`
  if (new RegExp(`^${key}=.*$`, 'm').test(env)) return env.replace(new RegExp(`^${key}=.*$`, 'm'), line)
  return `${env}${env.endsWith('\n') || env === '' ? '' : '\n'}${line}\n`
}

export async function ensureStackModel(opts: EnsureStackOpts): Promise<void> {
  const log = (msg: string) => console.error(`${opts.label}: ${msg}`)

  for (const f of opts.envFiles) {
    const p = join(repoRoot, f)
    if (existsSync(p)) (process as unknown as { loadEnvFile(p: string): void }).loadEnvFile(p)
  }

  if (process.env.WIKISTEAD_TEST_STACK !== opts.stack) {
    log(
      `refusing to run outside the isolated ${opts.stack} stack ` +
        `(WIKISTEAD_TEST_STACK != "${opts.stack}"). Run \`${opts.setupCmd}\` first (#268/#269).`,
    )
    process.exit(1)
  }

  const apiUrl = process.env.OPENFGA_API_URL ?? 'http://localhost:8080'
  const pinnedStoreId = process.env.OPENFGA_STORE_ID
  const pinnedModelId = process.env.OPENFGA_MODEL_ID
  const localEnvPath = join(repoRoot, opts.localEnvFile)

  // STORE drift first: find the live store by name. A dead pinned store id (volume
  // recreated by another session's setup) otherwise makes every later call fail.
  const fgaAnon = new OpenFgaClient({ apiUrl, storeId: DUMMY_STORE })
  let liveStoreId: string | undefined
  try {
    const { stores } = await (fgaAnon as unknown as { api: { listStores(): Promise<{ stores?: { id: string; name: string }[] }> } }).api.listStores()
    liveStoreId = stores?.find((s) => s.name === STORE_NAME)?.id
  } catch (e) {
    log(`cannot reach OpenFGA at ${apiUrl} (stack down?). Run \`${opts.setupCmd}\`. (${e})`)
    process.exit(1)
  }
  if (!liveStoreId) {
    // No store at all: healing the pin is pointless — a fresh store also has no seed
    // tuples, so only the full setup (bootstrap + seeds) can recover.
    log(`no "${STORE_NAME}" store exists on ${apiUrl} — run \`${opts.setupCmd}\` (seeds required).`)
    process.exit(1)
  }

  let storeId = pinnedStoreId
  let repointedStore = false
  if (storeId !== liveStoreId) {
    log(
      pinnedStoreId
        ? `pinned store ${pinnedStoreId} is DEAD (stack recreated) — re-pointing at live store ${liveStoreId}`
        : `no OPENFGA_STORE_ID pinned — pointing at live store ${liveStoreId}`,
    )
    storeId = liveStoreId
    repointedStore = true
  }

  const dsl = await readFile(join(repoRoot, 'infra/openfga/model.fga'), 'utf8')
  const wanted = transformer.transformDSLToJSONObject(dsl)
  const fga = new OpenFgaClient({ apiUrl, storeId })

  let modelId = pinnedModelId
  let wroteModel = false
  let matches = false
  if (modelId && !repointedStore) {
    try {
      const { authorization_model } = await fga.readAuthorizationModel({ authorizationModelId: modelId })
      matches =
        !!authorization_model &&
        JSON.stringify(canonicalModel(authorization_model)) === JSON.stringify(canonicalModel(wanted))
      if (matches) {
        log(`pinned model ${modelId} matches model.fga — ok`)
      } else {
        log(`pinned model ${modelId} is STALE (model.fga moved) — rewriting`)
      }
    } catch {
      log(`pinned model ${modelId} unreadable — rewriting`)
    }
  } else if (!repointedStore) {
    log('no OPENFGA_MODEL_ID pinned — writing the current model')
  }

  if (!matches) {
    const { authorization_model_id } = await fga.writeAuthorizationModel(wanted as never)
    modelId = authorization_model_id
    wroteModel = true
    log(`wrote model ${modelId}`)
  }

  if (repointedStore || wroteModel) {
    // Update the pins in the worktree-local env file only. Never touches the shared
    // committed env files (or dev/prod .env).
    let env = existsSync(localEnvPath) ? await readFile(localEnvPath, 'utf8') : ''
    env = upsertEnvVar(env, 'OPENFGA_STORE_ID', storeId!)
    env = upsertEnvVar(env, 'OPENFGA_MODEL_ID', modelId!)
    await writeFile(localEnvPath, env)
    log(`updated ${localEnvPath}`)
  }
}

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
// #253: the DSL transform and its canonical comparison now live in one place — this file and
// apps/server/src/openfga-guard.ts both import them rather than keeping their own copies.
// `infra/` is not a workspace member (no package.json), so this resolves through the root
// node_modules under tsx exactly as this file's `@openfga/sdk` import already does — which means
// it reads packages/authz's BUILT dist, so a runner that skips turbo's `^build` sees a stale one.
import { canonicalModel, dslToModel } from '@wikistead/authz'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

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
  const wanted = dslToModel(dsl)
  const fga = new OpenFgaClient({ apiUrl, storeId })

  // #751: WHICH matching model is pinned matters as much as whether one matches.
  //
  // OpenFGA keeps its LATEST model hot and reads any other one out of the datastore per check. Measured
  // on this stack, with the pin on an older (byte-identical) model: a 50-id batchCheck took 1111 ms
  // against the pin and 4 ms against the store's newest — about 22 ms per check, on a store that had
  // accumulated 63 models. `link-status`'s 256-id case is 6 sequential batches, so it timed out at 5 s
  // as a standing red, and every other check in the suite was paying the same toll invisibly.
  //
  // The old logic asked only "does the pinned model's CONTENT match model.fga", which stays true
  // forever while any number of identical models pile up behind it. So the question asked here is the
  // NEWEST model's content, and the pin follows it. Reproducibility is untouched: the model adopted is
  // byte-identical to the one that was pinned, by the same canonical comparison as before.
  let modelId = pinnedModelId
  let wroteModel = false
  let matches = false
  if (!repointedStore) {
    try {
      const { authorization_models } = await fga.readAuthorizationModels({ pageSize: 1 })
      const newest = authorization_models?.[0]
      const newestMatches =
        !!newest && JSON.stringify(canonicalModel(newest)) === JSON.stringify(canonicalModel(wanted))
      if (newestMatches && newest.id === modelId) {
        matches = true
        log(`pinned model ${modelId} matches model.fga and is the store's newest — ok`)
      } else if (newestMatches) {
        // A later write produced the same model — another session's setup, or this stack being
        // re-bootstrapped. Adopting it costs nothing and takes the per-check datastore read away.
        matches = true
        log(
          `pinned model ${modelId ?? '(none)'} is behind the store's newest ${newest.id}, which is the ` +
          'same model — re-pinning (a non-newest pin makes every check a datastore read, #751)',
        )
        modelId = newest.id
      } else {
        log(
          modelId
            ? `pinned model ${modelId} is STALE (model.fga moved) — rewriting`
            : 'no OPENFGA_MODEL_ID pinned — writing the current model',
        )
      }
    } catch {
      log(`could not read this store's models — rewriting`)
    }
  }

  if (!matches) {
    const { authorization_model_id } = await fga.writeAuthorizationModel(wanted as never)
    modelId = authorization_model_id
    wroteModel = true
    log(`wrote model ${modelId}`)
  }

  if (repointedStore || wroteModel || modelId !== pinnedModelId) {
    // Update the pins in the worktree-local env file only. Never touches the shared
    // committed env files (or dev/prod .env).
    let env = existsSync(localEnvPath) ? await readFile(localEnvPath, 'utf8') : ''
    env = upsertEnvVar(env, 'OPENFGA_STORE_ID', storeId!)
    env = upsertEnvVar(env, 'OPENFGA_MODEL_ID', modelId!)
    await writeFile(localEnvPath, env)
    log(`updated ${localEnvPath}`)
  }
}

// #825: rotating the isolated stack's permission store, and the one place that knows how.
//
// #823 established WHY a fat store has to go: every query OpenFGA runs is scoped by store id, a
// batched authorization check has a three-second deadline, and the batch is the only caller that
// feels the size — so the suite does not decline gradually, it goes from green to a standing red.
// What #823 did not cover is that the store gets fat again DURING a session: `setup:server-test`
// rotates it once, and every run after that piles onto the new one.
//
// Measured on one session's stack (offset 1), same 50-wide `page#view` batch, three passes each:
//
//   18 tuples (just rotated)        3.9 – 5.0 ms per id
//   5,426 tuples (one full run)     4.9 – 6.1 ms per id  — one run on its own costs nothing
//   48,364 tuples (a day of them)  19.3 ms per id        — 4.4x, all 50 still answered
//   216,503 tuples (#825 report)   ~70 ms per id         — and only 14-18 of 50 answered at all
//
// Where a day's worth came from is worth writing down, because it rules out the obvious fixes. Almost
// all of it is page tuples — 22,018 `published`, 12,087 `manage_direct`, 11,036 `space` — and 11,007
// of those pages hang off a space whose OWN tuples are already gone: suites clean up their space and
// leave the pages behind. Nor is there a culprit suite to fix: 12,033 of the `manage_direct` rows name
// `user:dev-user`, which is most of the server suite. It is a sweep, not a bug in one file.
//
// So the sequence below is shared rather than copied: `setup:server-test` runs it as part of standing
// the stack up, and `pnpm test` runs it first when the store has grown past the threshold. It is
// deliberately NOT run per package (`pnpm --filter … test`): turbo runs three packages against one
// stack at once, and rotating the store out from under a suite that is already running would take its
// model id with it.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How many tuples a store may hold before a run rotates it. Chosen from the measurements above: one
 * run leaves about 5,400 and costs no more than an empty store, while 48k costs 4.4x — enough to turn
 * a budgeted suite red. Twenty thousand is roughly four runs, so a session pays the rotation once in
 * a while rather than every time, and never reaches the range where answers stop coming back.
 */
export const REFRESH_THRESHOLD = 20_000

/** Pure, so the rule can be pinned without a stack: a store at the threshold is not yet over it. */
export function shouldRotate(tupleCount, threshold = REFRESH_THRESHOLD) {
  return Number.isFinite(tupleCount) && tupleCount > threshold
}

/**
 * The whole decision, as a value — so every branch can be pinned without a stack to run against, and
 * so the CLI is only the part that acts on it.
 *
 *   no-stack   this tree has never bootstrapped the isolated stack (a fresh clone, CI before setup)
 *   not-mine   the stack marker is not `server-test` — #269's valve: never touch a store we cannot
 *              prove is the throwaway one. ⚠️ It separates this stack from the DEV one and nothing
 *              else: the marker is a constant in a tracked env file, so it reads the same in every
 *              worktree. What keeps one session off another's store is the offset — a per-session
 *              `.env.server-test.local`, offset-derived URLs, and the port check in
 *              `reset-test-store.ts` that refuses an OpenFGA which is not this offset's.
 *   unknown    the store would not tell us its size (stack down, OpenFGA's schema moved)
 *   keep       under the threshold; the run gets the store it already has
 *   rotate     over it
 */
export function refreshVerdict({ hasLocalEnv, marker, tuples, threshold = REFRESH_THRESHOLD }) {
  if (!hasLocalEnv) return 'no-stack'
  if (marker !== 'server-test') return 'not-mine'
  if (tuples === null || tuples === undefined) return 'unknown'
  return shouldRotate(tuples, threshold) ? 'rotate' : 'keep'
}

/**
 * How many tuples this stack's permission store holds. Delegated to `infra/openfga/store-size.ts`
 * because the `postgres` client resolves from a tsx-run module and not from bare node at the
 * workspace root. Returns null when the answer cannot be had — the caller then does nothing, which
 * is the right move for a convenience step in front of a test run.
 */
export function countTuples({ repo, env }) {
  try {
    const out = execSync(
      'npx tsx --env-file=.env.server-test --env-file=.env.server-test.local infra/openfga/store-size.ts',
      { cwd: repo, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const n = Number(/TUPLES=(\d+)/.exec(out)?.[1])
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** The `.env.server-test.local` body — the store/model pins plus this session's stack URLs. */
export function localEnvBody({ ports, storeId, modelId }) {
  return [
    `# generated by setup:server-test — do not commit (stack offset ${ports.offset})`,
    `OPENFGA_STORE_ID=${storeId}`,
    `OPENFGA_MODEL_ID=${modelId}`,
    `DATABASE_URL=postgres://app:app@localhost:${ports.pg}/app`,
    `DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:${ports.pg}/app`,
    `VALKEY_URL=redis://localhost:${ports.valkey}`,
    `OPENFGA_API_URL=http://localhost:${ports.fgaHttp}`,
    `MEILI_HOST=http://localhost:${ports.meili}`,
    `S3_ENDPOINT=http://localhost:${ports.s3}`,
    `SMTP_PORT=${ports.smtp}`,
    `MAILPIT_API_URL=http://localhost:${ports.mailpit}/api/v1`,
    ``,
  ].join('\n')
}

/**
 * #870: the environment every step AFTER the bootstrap must run with.
 *
 * A real environment variable beats `--env-file` — Node never lets an env file override one that is
 * already set, which is the whole mechanism #484 relies on to move a session onto its own stack. The
 * caller here loads `.env.server-test.local` into its own process (it has to: that is where the offset
 * lives) and hands its `process.env` to every child, so the child carries the store id of the store
 * this rotation just RETIRED — and the `--env-file` naming the freshly written local file cannot
 * override it. The seed then reports success against a store nobody will ever read again, and the new
 * one is left with a model and no tuples.
 *
 * That is not a cosmetic ordering problem. `user:dev-user member tenant:tenant_dev` is what the
 * per-request membership seam asks about, so a store without it fails every authenticated request in
 * three different voices — 401 `unauthorized` from the API, "space creation is restricted" from the
 * create path (`space_creator` unions `tenant#member`), and `forbidden: not a member of this tenant`
 * from collab's own gate. It reads as an authorization regression in whatever landed last, and it was
 * read that way four times in one day across three sessions before it was measured.
 */
export function postBootstrapEnv(env, { storeId, modelId }) {
  return { ...env, OPENFGA_STORE_ID: storeId, OPENFGA_MODEL_ID: modelId }
}

/**
 * Retire the fat store, bootstrap an empty one, re-pin it, and re-establish what the seeds own.
 * Every step is the one `setup:server-test` was already running; this is where they live now.
 */
/**
 * The real child-process runner. Taken as a parameter so the rotation's ORDER and the environment each
 * step receives can be pinned without a stack: the defect #870 fixes was invisible to any test that
 * could not see what the seed step was handed.
 */
export const shellRunner = (repo) => ({
  run: (cmd, childEnv) => execSync(cmd, { cwd: repo, stdio: 'inherit', env: childEnv }),
  capture: (cmd, childEnv) => execSync(cmd, { cwd: repo, encoding: 'utf8', env: childEnv }),
  write: (path, body) => writeFileSync(path, body),
})

export function rotateStore({ repo, ports, env, localEnvPath, runner = shellRunner(repo) }) {
  const ENVS = '--env-file=.env.server-test --env-file=.env.server-test.local'
  const run = (cmd, childEnv = env) => runner.run(cmd, childEnv)
  const capture = (cmd) => runner.capture(cmd, env)

  console.log('[server-test] retire the previous permission store…')
  run(`npx tsx ${ENVS} infra/openfga/reset-test-store.ts`)

  console.log('[server-test] fga bootstrap…')
  const out = capture('npx tsx --env-file=.env.server-test infra/openfga/bootstrap.ts')
  const storeId = /OPENFGA_STORE_ID=(.+)/.exec(out)?.[1]?.trim()
  const modelId = /OPENFGA_MODEL_ID=(.+)/.exec(out)?.[1]?.trim()
  if (!storeId || !modelId) throw new Error(`bootstrap did not emit store/model ids:\n${out}`)
  // #484: `.env.server-test.local` loads BEFORE `.env.server-test` and wins (loadEnvFile never
  // overrides an already-set var), so the offset-derived URLs here move the suite onto this session's
  // stack. At offset 0 they equal the static values — a harmless restatement.
  runner.write(localEnvPath, localEnvBody({ ports, storeId, modelId }))
  console.log(`[server-test] wrote .env.server-test.local (store ${storeId}, pg ${ports.pg}, fga ${ports.fgaHttp})`)

  // Every step from here on is about the NEW store, and says so in its environment rather than trusting
  // the file it was just handed to win an argument it cannot win (see `postBootstrapEnv`).
  const fresh = postBootstrapEnv(env, { storeId, modelId })

  console.log('[server-test] fga seed…')
  run(`npx tsx ${ENVS} infra/openfga/seed.ts`, fresh)

  // #788: drop what earlier runs left behind. `sweepExpiredTrash` walks every tenant, so a stack that
  // has been up for hours pays for hundreds of fixtures nobody collected — measured at 33 seconds to
  // purge one page tree with 979 of them present. #821 does the same for role definitions.
  console.log('[server-test] prune leftover test tenants…')
  run(`npx tsx ${ENVS} infra/db/prune-test-tenants.ts`, fresh)

  // Idempotent, and here rather than only in `setup:server-test` so a rotation leaves exactly the
  // state a fresh setup leaves: the two seeded tenants exist in BOTH the database and the new store.
  console.log('[server-test] db seed…')
  run(`npx tsx --env-file=.env.server-test infra/db/seed.ts`, fresh)

  return { storeId, modelId }
}

// ── #870: is the store this run is about to use actually seeded? ──────────────────────────────────
//
// The rotation above is fixed, but it is not the only way a store ends up modelled and empty: a manual
// reset, another session's mistake, a future change to these steps. The cost of finding out late is
// what #870 measured — three sessions reading an unseeded stack as an authorization regression in
// whatever had just landed, four times in one day, because the failure arrives as 401s and 403s in
// suites that touched nothing.
//
// So the run asks one question first, and asks it of the TUPLES rather than of a symptom. There is no
// symptom that covers all three voices (the API's 401, the create path's refusal, collab's own gate),
// and each of them looks like a different bug.

/**
 * What the seed writes for the dev tenant, READ FROM THE SEED. A hand-written copy here would be a
 * second declaration of the fixture, and the two would drift the first time somebody added a tuple —
 * which is the shape #790 and #848 are both about. Only the first block is read: it is the hierarchy
 * every authenticated request depends on, and the share-link blocks below it are about one feature.
 */
export function seedTuples(repo) {
  try {
    const src = readFileSync(join(repo, 'infra/openfga/seed.ts'), 'utf8')
    const block = /writeIdempotent\(\[([\s\S]*?)\]\)/.exec(src)?.[1]
    if (!block) return null
    const out = []
    for (const m of block.matchAll(/\{\s*user:\s*'([^']+)'\s*,\s*relation:\s*'([^']+)'\s*,\s*object:\s*'([^']+)'/g)) {
      out.push({ user: m[1], relation: m[2], object: m[3] })
    }
    return out.length ? out : null
  } catch {
    return null
  }
}

/**
 * Three answers, never two. `missing` means the store is up, answered, and does not hold the seed —
 * the case worth stopping for. `unknown` covers every way the question could not be put: no stack, the
 * store id points at something retired, the model does not have these types (a store whose LATEST model
 * is a stub answers a plain check with `validation_error`, which is a different problem with a different
 * fix). Folding `unknown` into `missing` would turn a convenience into a gate that fails a machine which
 * simply has no isolated stack.
 *
 * ⚠️ The check PINS the model id. Without it OpenFGA answers against whatever model is newest in the
 * store, and the suite writes models of its own — so an unpinned probe reports a broken stack on a
 * perfectly good one. That is not hypothetical: it is how this check's first diagnostic recipe misled
 * two sessions.
 */
export async function seedPresence({ env, tuples, fetchImpl = fetch }) {
  const url = env.OPENFGA_API_URL
  const store = env.OPENFGA_STORE_ID
  const model = env.OPENFGA_MODEL_ID
  if (!url || !store || !model || !tuples?.length) return { verdict: 'unknown', why: 'no store pinned in this environment' }
  const missing = []
  for (const t of tuples) {
    let body
    try {
      const r = await fetchImpl(`${url}/stores/${store}/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authorization_model_id: model, tuple_key: t }),
      })
      body = await r.json()
    } catch (err) {
      return { verdict: 'unknown', why: `the permission store could not be reached (${err?.message ?? err})` }
    }
    if (body?.code) return { verdict: 'unknown', why: `the store would not answer: ${body.code} ${body.message ?? ''}`.trim() }
    if (body?.allowed !== true) missing.push(t)
  }
  return missing.length ? { verdict: 'missing', missing } : { verdict: 'present' }
}

/** The sentence a session should read when the store is empty. One command fixes it. */
export function unseededMessage(missing, offset) {
  const one = missing[0]
  return (
    `[store-refresh] the permission store is MODELLED BUT NOT SEEDED — ${missing.length} seed tuple(s) absent, ` +
    `e.g. \`${one.user} ${one.relation} ${one.object}\`.\n` +
    `  Every authenticated request will fail, and it will not say why: the API answers 401 unauthorized, ` +
    `the create path answers "space creation is restricted", and collab answers "not a member of this tenant". ` +
    `None of them is a bug in whatever you just changed.\n` +
    `  Recover: WKS_STACK_OFFSET=${offset} pnpm setup:server-test`
  )
}

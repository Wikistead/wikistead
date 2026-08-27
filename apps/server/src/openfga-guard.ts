/**
 * Production safety guard for the OpenFGA datastore (ADR-035).
 *
 * OpenFGA is the single source of truth for authorization (the project design notes). Its in-memory
 * datastore engine loses every tuple on restart — fine for dev/e2e, catastrophic in
 * production (all authorization relations vanish → authz collapse). This fail-fast guard
 * refuses to start the API in production unless OpenFGA is backed by a persistent engine,
 * so a misconfigured deploy stops loudly instead of silently running with no/empty authz.
 *
 * The deploy must pass `OPENFGA_DATASTORE_ENGINE` to the API process (same value used for
 * the OpenFGA service) so this check can verify it.
 */
export function assertProductionFgaPersistent(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const engine = (env.OPENFGA_DATASTORE_ENGINE ?? 'memory').toLowerCase();
  if (engine !== 'postgres') {
    throw new Error(
      'FATAL: OpenFGA in-memory datastore is forbidden in production. Authorization tuples ' +
        'would be lost on restart, collapsing all access control. Set ' +
        'OPENFGA_DATASTORE_ENGINE=postgres for the OpenFGA service and pass it to the API. ' +
        `Got OPENFGA_DATASTORE_ENGINE="${engine}".`,
    );
  }
}

// #433: non-production startup guard against FGA MODEL DRIFT. When a parallel worktree
// re-bootstraps the shared dev store (or model.fga moves under a stale .env pin), every
// check silently runs against the wrong model shape — pages stop creating, suites go red
// in data-shaped ways, and the cause is invisible. This converts that silence into an
// explicit config error at startup: the pinned OPENFGA_MODEL_ID must exist in the store
// AND match the repo's model.fga.
//
// Scope: skipped in production (models are pinned by the deploy; infra/ does not ship)
// and when model.fga is not present next to the running source. Escape hatch:
// WIKISTEAD_SKIP_FGA_MODEL_GUARD=1.

const RECOVERY =
  'Recover: for dev, re-run `pnpm --filter @wikistead/server fga:bootstrap` and update ' +
  'OPENFGA_STORE_ID / OPENFGA_MODEL_ID in .env (or `pnpm dev:setup` — WARNING: wipes dev FGA ' +
  'tuples). For the test stacks run `pnpm setup:server-test` / `pnpm setup:e2e` (their suite ' +
  'commands also self-heal). Bypass (not recommended): WIKISTEAD_SKIP_FGA_MODEL_GUARD=1.';

export async function assertFgaModelFresh(
  env: NodeJS.ProcessEnv = process.env,
  opts: { tries?: number; delayMs?: number } = {},
): Promise<void> {
  if (env.NODE_ENV === 'production') return;
  if (env.WIKISTEAD_SKIP_FGA_MODEL_GUARD === '1') return;

  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { chooseModelDslPath } = await import('./openfga-model-path.js');
  // ADR-253 §3.2: two candidates, no operator override — an authorization model may not differ
  // from the image's, unlike a migration's SQL. Neither present is a refusal, not a shrug: a boot
  // that cannot read the model it is supposed to speak says so, in words a downstream throw does
  // not carry.
  const choice = chooseModelDslPath(dirname(fileURLToPath(import.meta.url)), existsSync);
  if (choice.kind === 'none') {
    throw new Error(
      `FATAL: infra/openfga/model.fga is not present at either place this guard looks: ` +
        `${choice.candidates.join(', ')} (#433 drift guard, ADR-253 §3.2). ${RECOVERY}`,
    );
  }
  const modelPath = choice.path;

  const storeId = env.OPENFGA_STORE_ID;
  const modelId = env.OPENFGA_MODEL_ID;
  if (!storeId || !modelId) {
    throw new Error(
      `FATAL: OPENFGA_STORE_ID / OPENFGA_MODEL_ID missing from the environment — the FGA model ` +
        `guard cannot verify the authz model (#433). ${RECOVERY}`,
    );
  }

  const [{ dslToModel, canonicalModel }, { OpenFgaClient }] = await Promise.all([
    import('@wikistead/authz'),
    import('@openfga/sdk'),
  ]);
  const wanted = dslToModel(await readFile(modelPath, 'utf8'));
  const fga = new OpenFgaClient({ apiUrl: env.OPENFGA_API_URL ?? 'http://localhost:8080', storeId });

  // Retry a few times: `pnpm dev` often races `docker compose up`. After the retries any
  // failure (store dead, model id unknown, FGA down) becomes the same explicit config error.
  const tries = opts.tries ?? 5;
  const delayMs = opts.delayMs ?? 1000;
  let current: unknown;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const { authorization_model } = await fga.readAuthorizationModel({ authorizationModelId: modelId });
      current = authorization_model;
      break;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (!current) {
    throw new Error(
      `FATAL: pinned FGA model ${modelId} could not be read from store ${storeId} — the store was ` +
        `recreated, the pin is stale, or OpenFGA is unreachable (#433 drift guard). ` +
        `Last error: ${lastErr}. ${RECOVERY}`,
    );
  }
  if (JSON.stringify(canonicalModel(current)) !== JSON.stringify(canonicalModel(wanted))) {
    throw new Error(
      `FATAL: pinned FGA model ${modelId} does not match this checkout's infra/openfga/model.fga — ` +
        `the model moved (rebase / parallel session) and authz checks would run against the wrong ` +
        `shape (#433 drift guard). ${RECOVERY}`,
    );
  }
}

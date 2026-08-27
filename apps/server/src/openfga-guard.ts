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

// ADR-253 §3.1-§3.8: the product finds (or, on a deployment that has never had one, creates) its
// own OpenFGA store, and keeps its model reconciled to the DSL the running image carries — in every
// environment, not just non-production. This REPLACES #433's old guard, which read
// OPENFGA_STORE_ID / OPENFGA_MODEL_ID directly from the environment, required both, and skipped
// itself entirely in production (§1(b): production had NO model verification at all).
//
// §8③ (ruled 2026-08-26, option iv): the model comparison below runs ONLY on the boot that WROTE a
// model — a boot that adopted an existing one is "the same implementation reading the same file
// twice" and gets no second opinion from reading it a third time. A boot that wrote and cannot read
// its own write back refuses: in this deployment's shape (`server` at 2 replicas, `openfga` at 1),
// at most one of two pods can ever be the writer, and a refusal there closes into a restart-and-
// re-resolve loop that only a genuinely broken store keeps open (ADR-253 §8③①②).
const RECOVERY =
  'Recover: for dev, re-run `pnpm --filter @wikistead/server fga:bootstrap` and update ' +
  'OPENFGA_STORE_ID / OPENFGA_MODEL_ID in .env (or `pnpm dev:setup` — WARNING: wipes dev FGA ' +
  'tuples). For the test stacks run `pnpm setup:server-test` / `pnpm setup:e2e` (their suite ' +
  'commands also self-heal).';

export async function resolveFgaForBoot(
  env: NodeJS.ProcessEnv,
  sql: import('postgres').Sql,
  opts: { tries?: number; delayMs?: number; log?: (line: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const { existsSync } = await import('node:fs');
  const { readFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { chooseModelDslPath } = await import('./openfga-model-path.js');
  const { OpenFgaClient } = await import('@openfga/sdk');
  const {
    resolveStoreBindingLocked,
    reconcileModel,
    DUMMY_STORE_ID,
  } = await import('./openfga-resolve.js');
  const { supplyResolvedFga } = await import('@wikistead/authz');

  // ADR-253 §3.2: the DSL is needed before the store can be bound to a model at all — resolve it
  // first so a missing DSL refuses before any network call, in words naming both candidates.
  const choice = chooseModelDslPath(dirname(fileURLToPath(import.meta.url)), existsSync);
  if (choice.kind === 'none') {
    throw new Error(
      `FATAL: infra/openfga/model.fga is not present at either place this guard looks: ` +
        `${choice.candidates.join(', ')} (ADR-253 §3.2). ${RECOVERY}`,
    );
  }
  const dsl = await readFile(choice.path, 'utf8');

  const apiUrl = env.OPENFGA_API_URL ?? 'http://localhost:8080';
  const anonymous = new OpenFgaClient({ apiUrl, storeId: DUMMY_STORE_ID });
  const binding = await resolveStoreBindingLocked(sql, anonymous, env.OPENFGA_STORE_ID);

  if (binding.kind === 'wait-for-migration') {
    throw new Error(
      'FATAL: this database has not been migrated far enough to have the OpenFGA store-binding ' +
        'witness (ADR-253 §3.4a) — run the migrate job first. ' + RECOVERY,
    );
  }
  if (binding.kind === 'refuse') {
    throw new Error(`FATAL: ${binding.message}. ${RECOVERY}`);
  }

  const fga = new OpenFgaClient({ apiUrl, storeId: binding.storeId });
  const reconciled = await reconcileModel(fga, binding.storeId, dsl, env.OPENFGA_MODEL_ID);

  const skip = env.WIKISTEAD_SKIP_FGA_MODEL_GUARD === '1';
  if (reconciled.wrote && !skip) {
    const tries = opts.tries ?? 5;
    const delayMs = opts.delayMs ?? 1000;
    let readBack: unknown;
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        const { authorization_model } = await fga.readAuthorizationModel({ authorizationModelId: reconciled.modelId });
        readBack = authorization_model;
        break;
      } catch (e) {
        lastErr = e;
        if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    if (!readBack) {
      throw new Error(
        `FATAL: this boot wrote model ${reconciled.modelId} to store ${binding.storeId} and could ` +
          `not read it back — the write may not have landed (ADR-253 §8③). Last error: ${lastErr}. ` +
          RECOVERY,
      );
    }
  }

  supplyResolvedFga(fga, reconciled.modelId);

  // ADR-253 §3.8/§6: what this boot actually connected to, and whether anything went unverified —
  // an operator must be able to answer "what am I authorizing against" without reading the code.
  const storeState = env.OPENFGA_STORE_ID ? 'given' : binding.created ? 'created' : 'found';
  const modelState = reconciled.wrote ? 'written' : 'found';
  const expected = reconciled.expectedButNotAdopted
    ? ` (OPENFGA_MODEL_ID expected ${reconciled.expectedButNotAdopted}, not adopted)`
    : '';
  const skipNote = reconciled.wrote && skip ? ' — WIKISTEAD_SKIP_FGA_MODEL_GUARD=1: this write was NOT verified' : '';
  log(
    `openfga-resolve: store=${binding.storeId} (${storeState}), model=${reconciled.modelId} ` +
      `(${modelState})${expected}${skipNote}`,
  );
}

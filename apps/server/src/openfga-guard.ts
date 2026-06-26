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

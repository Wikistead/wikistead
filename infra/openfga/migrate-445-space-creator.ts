// #445 / ADR-171 migration: rewrite the retiring `tenant_settings.space_creation_policy` knob into
// the `tenant#space_creator@user:*` wildcard tuple, per tenant:
//   - policy 'members' (or no row — the default): write the wildcard  → all members may create.
//   - policy 'admins': write NOTHING                                  → admins only (`or admin`).
// Identical observable behaviour before and after (the ADR's migration anti-test).
//
// RETIRED by #471. It writes `space_creator@user:*`, which the current model no longer accepts — so
// against a store carrying the #471 model this script FAILS rather than doing something subtly
// wrong. A store that never ran it wants migrate-471-space-creator-userset.ts, which writes the
// userset form directly; a store that did run it wants that script too, to rewrite what this wrote.
// Kept only as the historical record of what the ADR-171 migration did.
//
// Run AFTER `fga:bootstrap` writes the ADR-171 model (space_creator must exist) and BEFORE DB
// migration 075 drops the column, against the SAME persistent datastore (dev + prod). Fresh
// e2e/server-test stacks seed the wildcard directly and do NOT need this. Idempotent: an existing
// wildcard is left in place.
import postgres from 'postgres'
import { OpenFgaClient } from '@openfga/sdk'

;(async () => {
  const apiUrl = process.env.OPENFGA_API_URL ?? 'http://localhost:8080'
  const storeId = process.env.OPENFGA_STORE_ID
  const modelId = process.env.OPENFGA_MODEL_ID
  if (!storeId) { console.error('OPENFGA_STORE_ID required'); process.exit(1) }
  const fga = new OpenFgaClient({ apiUrl, storeId, ...(modelId ? { authorizationModelId: modelId } : {}) })

  const dbUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!
  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} })
  const tenants = await sql<{ id: string; policy: string | null }[]>`
    SELECT t.id, ts.space_creation_policy AS policy
    FROM tenants t LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id`
  await sql.end()

  let wrote = 0
  for (const t of tenants) {
    if (t.policy === 'admins') { console.log(`tenant ${t.id}: policy=admins → no wildcard (admins only)`); continue }
    const tuple = { user: 'user:*', relation: 'space_creator', object: `tenant:${t.id}` }
    const { tuples } = await fga.read({ user: tuple.user, object: tuple.object })
    if ((tuples ?? []).some((x) => x.key?.relation === 'space_creator')) {
      console.log(`tenant ${t.id}: wildcard already present`)
      continue
    }
    await fga.write({ writes: [tuple] })
    wrote += 1
    console.log(`tenant ${t.id}: wrote space_creator wildcard`)
  }
  console.log(`done — ${wrote} wildcard tuple(s) written across ${tenants.length} tenant(s)`)
})().catch((err) => { console.error(err); process.exit(1) })

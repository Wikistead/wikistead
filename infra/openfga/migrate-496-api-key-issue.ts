// #496 / ADR-181 migration: rewrite the retiring `tenant_settings.api_key_issue_policy` enum into the
// `api_key_issue` relation, per tenant — the same shape #445 used to retire `space_creation_policy`:
//   - policy 'members' (or NULL — #462's default): write `api_key_issue@tenant:<id>#member`
//                                                  → every member may mint a key, as before.
//   - policy 'admins_only':                        write NOTHING
//                                                  → admins only, via the model's `or admin` arm.
// Observable behaviour is identical before and after; only the authority moves (a settings column →
// an FGA tuple), which is the whole point of the ADR. The userset form (`tenant:<id>#member`) is used,
// never `user:*` — #471 measured that a typed wildcard matches every principal the server authenticates,
// including members of OTHER tenants.
//
// Run AFTER `fga:bootstrap` writes the ADR-181 model (api_key_issue must exist) and BEFORE DB migration
// 084 drops the column, against the SAME persistent datastore (dev + prod). Fresh e2e / server-test
// stacks start from the new model with no column to read and do NOT need this. Idempotent: a tenant that
// already carries the tuple is left alone, so a re-run is safe.
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
  // LEFT JOIN so a tenant with no settings row (the common case) is included and read as NULL = 'members'.
  const tenants = await sql<{ id: string; policy: string | null }[]>`
    SELECT t.id, ts.api_key_issue_policy AS policy
    FROM tenants t LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id`
  await sql.end()

  let wrote = 0
  for (const t of tenants) {
    if (t.policy === 'admins_only') { console.log(`tenant ${t.id}: policy=admins_only → no member tuple (admins only)`); continue }
    const tuple = { user: `tenant:${t.id}#member`, relation: 'api_key_issue', object: `tenant:${t.id}` }
    // fga-read-ok: ONE principal on ONE object — a (user, relation, object) tuple is unique, so the row count is bounded by the type's relation count (<20), never by tenant size.
    const { tuples } = await fga.read({ user: tuple.user, object: tuple.object })
    if ((tuples ?? []).some((x) => x.key?.relation === 'api_key_issue')) {
      console.log(`tenant ${t.id}: member tuple already present`)
      continue
    }
    await fga.write({ writes: [tuple] })
    wrote += 1
    console.log(`tenant ${t.id}: wrote api_key_issue@tenant#member (policy=${t.policy ?? 'NULL→members'})`)
  }
  console.log(`done — ${wrote} member tuple(s) written across ${tenants.length} tenant(s)`)
})().catch((err) => { console.error(err); process.exit(1) })

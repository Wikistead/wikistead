// #471 / ADR-176 migration: rewrite `tenant:<id>#space_creator@user:*` as
// `tenant:<id>#space_creator@tenant:<id>#member`.
//
// ADR-171 seeded the "all members may create spaces" default as a typed wildcard. A typed wildcard
// matches EVERY principal of that type, so the grant read as "anyone this server ever authenticates
// as a user" rather than "anyone in this tenant" — and it was measurably the relation an outsider
// rode in on (#471a non-member created a space they then managed). A userset says what was
// meant, exactly, and needs no per-member tuple to maintain: membership already lives in FGA.
//
// Run after deploying the #471 model (space_creator must accept `tenant#member`), against the same
// persistent datastore. Idempotent: a tenant already carrying the userset is skipped, and a tenant
// with NO wildcard is left alone — its admins-only setting must survive the migration untouched.
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
  const tenants = await sql<{ id: string }[]>`SELECT id FROM tenants ORDER BY created_at`
  await sql.end()

  let rewritten = 0
  for (const t of tenants) {
    const object = `tenant:${t.id}`
    const userset = { user: `${object}#member`, relation: 'space_creator', object }
    const wildcard = { user: 'user:*', relation: 'space_creator', object }

    const already = await fga.read({ user: userset.user, object })
    if ((already.tuples ?? []).some((x) => x.key?.relation === 'space_creator')) {
      console.log(`tenant ${t.id}: already grants its members`)
      continue
    }
    const old = await fga.read({ user: wildcard.user, object })
    if (!(old.tuples ?? []).some((x) => x.key?.relation === 'space_creator')) {
      console.log(`tenant ${t.id}: admins only — nothing to rewrite`)
      continue
    }
    // Write first: a crash between the two leaves the tenant over-permitted for a moment rather than
    // locking every member out of space creation, and the next run cleans it up.
    await fga.write({ writes: [userset] })
    await fga.write({ deletes: [wildcard] })
    rewritten += 1
    console.log(`tenant ${t.id}: space_creator now names its members, not user:*`)
  }
  console.log(`done — ${rewritten} of ${tenants.length} tenant(s) rewritten`)
})().catch((err) => { console.error(err); process.exit(1) })

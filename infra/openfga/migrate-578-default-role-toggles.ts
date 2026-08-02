// #578 / ADR-201 rev3 slice 5, the FGA half of the conversion.
//
// Migration 100 converts the assignments the default-role evaluator made; this writes the INTENT it
// expressed. For every tenant that had a `default_role_id`, the role's tenant capabilities become the
// every-member tuples the admin screen's toggles read — `tenant:<id>#member` → `space_creator` /
// `api_key_issue`. "All members get this" survives the setting that used to say it.
//
// Runs AFTER `fga:bootstrap`, against the same persistent datastore (dev + prod). Idempotent: an
// existing tuple is skipped, so a second run writes nothing. Fresh e2e / server-test stacks have no
// default roles and no-op.
import postgres from 'postgres'
import { OpenFgaClient } from '@openfga/sdk'

const CAP_RELATION: Record<string, string> = { createSpaces: 'space_creator', issueApiKeys: 'api_key_issue' }

;(async () => {
  const apiUrl = process.env.OPENFGA_API_URL ?? 'http://localhost:8080'
  const storeId = process.env.OPENFGA_STORE_ID
  const modelId = process.env.OPENFGA_MODEL_ID
  if (!storeId) { console.error('OPENFGA_STORE_ID required'); process.exit(1) }
  const fga = new OpenFgaClient({ apiUrl, storeId, ...(modelId ? { authorizationModelId: modelId } : {}) })

  const sql = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })
  // The column is still there (its DROP is a later migration, #499's rule), which is what makes this
  // script runnable at all — read it before it goes.
  const rows = await sql<{ tenant_id: string; capabilities: string[] }[]>`
    SELECT ts.tenant_id, r.capabilities
    FROM tenant_settings ts JOIN roles r ON r.id = ts.default_role_id
    WHERE ts.default_role_id IS NOT NULL`
  await sql.end()

  let written = 0
  for (const { tenant_id: tenantId, capabilities } of rows) {
    const wanted = (capabilities ?? []).map((c) => CAP_RELATION[c]).filter((r): r is string => !!r)
    if (wanted.length === 0) continue
    // #574's lesson: read the existing tuples with the SAME filter and skip what is already there —
    // OpenFGA 400s a duplicate write, which would abort the whole tenant.
    const res = await (fga as any).read({ user: `tenant:${tenantId}#member`, object: `tenant:${tenantId}` })
    const have = new Set(((res.tuples ?? []) as { key?: { relation?: string } }[]).map((t) => t.key?.relation))
    const writes = wanted.filter((r) => !have.has(r)).map((relation) => ({
      user: `tenant:${tenantId}#member`, relation, object: `tenant:${tenantId}`,
    }))
    if (writes.length === 0) continue
    await fga.write({ writes }).catch((e: unknown) => { console.error(`write failed for ${tenantId}`, e); throw e })
    written += writes.length
    console.error(`tenant ${tenantId}: +${writes.length} member toggle(s) from the retired default role`)
  }
  console.error(`migrate-578-default-role-toggles: wrote ${written} tuple(s) across ${rows.length} tenant(s)`)
})().catch((e) => { console.error(e); process.exit(1) })

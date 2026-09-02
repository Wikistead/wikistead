// ADR-252 §1 / #810: executeDatabaseSweep — the first genuinely destructive step. Integration (real
// Postgres). This is the highest-stakes pin in this ticket: it is the one that actually deletes rows,
// so the fixture exercises every safety property the review's earlier pass on this
// directory's discovery layer named as load-bearing:
//   - a KEPT space's row, settings, and SPACE-level share link SURVIVE
//   - a KEPT space's PAGE (and everything cascading from it) is swept anyway (§1's corrected semantics)
//   - a TENANT-tier role_assignment is untouched (the polymorphic-table collateral-damage warning)
//   - api_keys.space_ids is left exactly as it was (meant to go stale, never swept)
//   - a template survives regardless of its source page/space (frozen snapshot, migration 051)
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { executeDatabaseSweep, UnclassifiableSchemaError } from '../tenant-sweep/execute-database.js'
import { computeDoomedIds } from '../tenant-sweep/doomed-ids.js'
import { writeResetManifest } from '../tenant-sweep/write-manifest.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_t810ed'

const kept = { space: 'space_t810ed_kept', page: 'page_t810ed_kept' }
const doomed = { space: 'space_t810ed_doomed', page: 'page_t810ed_doomed' }

async function seed(): Promise<void> {
  await admin`INSERT INTO tenants (id, slug, plan) VALUES (${TENANT}, 't810ed', 'business')
    ON CONFLICT (slug) DO UPDATE SET plan = EXCLUDED.plan`
  for (const s of [kept, doomed]) {
    await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${s.space}, ${TENANT}, ${s.space}) ON CONFLICT (id) DO NOTHING`
    await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc) VALUES (${s.page}, ${TENANT}, ${s.space}, ${s.page}, ${Buffer.from([])}) ON CONFLICT (id) DO NOTHING`
    await admin`INSERT INTO attachments (id, tenant_id, page_id, filename, content_type, size_bytes, s3_key, status)
      VALUES (${s.page + '_att'}, ${TENANT}, ${s.page}, 'f.png', 'image/png', 10, ${s.space + '/att-key'}, 'confirmed') ON CONFLICT (id) DO NOTHING`
    // SPACE-level share link — this is the safety property #1045's design review named by name
    await admin`INSERT INTO share_links (id, tenant_id, resource_type, resource_id, capability, created_by)
      VALUES (${s.space + '_spacelink'}, ${TENANT}, 'space', ${s.space}, 'view', 'user:dev-user') ON CONFLICT (id) DO NOTHING`
    // PAGE-level share link — swept regardless of kept/doomed (every page is swept)
    await admin`INSERT INTO share_links (id, tenant_id, resource_type, resource_id, capability, created_by)
      VALUES (${s.page + '_pagelink'}, ${TENANT}, 'page', ${s.page}, 'view', 'user:dev-user') ON CONFLICT (id) DO NOTHING`
  }
  // a TENANT-tier grant — must survive untouched (the collateral-damage warning derive.ts names)
  await admin`INSERT INTO roles (id, tenant_id, name, capabilities) VALUES ('role_t810ed', ${TENANT}, 'role_t810ed', ${[]})
    ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO role_assignments (id, tenant_id, role_id, resource_type, resource_id, principal)
    VALUES ('ra_t810ed_tenant', ${TENANT}, 'role_t810ed', 'tenant', ${TENANT}, 'user:dev-user') ON CONFLICT (id) DO NOTHING`
  // a SPACE-tier grant on the DOOMED space — must be swept
  await admin`INSERT INTO role_assignments (id, tenant_id, role_id, resource_type, resource_id, principal)
    VALUES ('ra_t810ed_doomedspace', ${TENANT}, 'role_t810ed', 'space', ${doomed.space}, 'user:dev-user') ON CONFLICT (id) DO NOTHING`
  // an API key confined to the doomed space — space_ids must be left exactly as-is
  await admin`INSERT INTO api_keys (id, tenant_id, owner_user_id, name, key_prefix, key_hash, space_ids)
    VALUES ('key_t810ed', ${TENANT}, 'dev-user', 'k', 'kb_t810ed', 'hash', ${[doomed.space]}) ON CONFLICT (id) DO NOTHING`
  // a template sourced from the doomed page — must survive (frozen snapshot, migration 051)
  await admin`INSERT INTO templates (id, tenant_id, name, body_md, source_page_id, scope, space_id, created_by)
    VALUES ('tpl_t810ed', ${TENANT}, 'tpl', '# frozen', ${doomed.page}, 'space', ${doomed.space}, 'user:dev-user') ON CONFLICT (id) DO NOTHING`
}

afterAll(async () => {
  for (const tbl of ['templates', 'api_keys', 'role_assignments', 'roles', 'share_links', 'attachments', 'pages', 'spaces']) {
    await admin.unsafe(`DELETE FROM ${tbl} WHERE tenant_id = '${TENANT}'`).catch(() => {})
  }
  await admin`DELETE FROM tenant_sweep_progress WHERE manifest_id IN (SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT})`.catch(() => {})
  await admin`DELETE FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await admin.end()
})

describe('executeDatabaseSweep (ADR-252 §1, #810)', () => {
  it('sweeps the doomed space entirely, empties the kept space\'s page, and leaves every named survivor untouched', async () => {
    await seed()
    const { manifestId, doomed: doomedIds } = await writeResetManifest(admin, TENANT, [kept.space])
    await executeDatabaseSweep(admin, manifestId, TENANT, doomedIds)

    // --- gone ---
    const remainingPages = await admin<{ id: string }[]>`SELECT id FROM pages WHERE tenant_id = ${TENANT}`
    expect(remainingPages, 'every page — kept space or not — is swept').toEqual([])
    const remainingSpaces = await admin<{ id: string }[]>`SELECT id FROM spaces WHERE tenant_id = ${TENANT}`
    expect(remainingSpaces.map((r) => r.id)).toEqual([kept.space])
    const remainingAttachments = await admin<{ id: string }[]>`SELECT id FROM attachments WHERE tenant_id = ${TENANT}`
    expect(remainingAttachments, 'attachments cascade with their page, kept space or not').toEqual([])
    const remainingPageLinks = await admin<{ id: string }[]>`SELECT id FROM share_links WHERE tenant_id = ${TENANT} AND resource_type = 'page'`
    expect(remainingPageLinks, 'page-level share links are swept for every page').toEqual([])
    const doomedSpaceLink = await admin<{ id: string }[]>`SELECT id FROM share_links WHERE id = ${doomed.space + '_spacelink'}`
    expect(doomedSpaceLink, "the doomed space's own share link is swept with it").toEqual([])
    const doomedSpaceGrant = await admin<{ id: string }[]>`SELECT id FROM role_assignments WHERE id = 'ra_t810ed_doomedspace'`
    expect(doomedSpaceGrant, 'the doomed space-tier grant is swept').toEqual([])

    // --- survives — the properties #1045's review named ---
    const keptSpaceLink = await admin<{ id: string }[]>`SELECT id FROM share_links WHERE id = ${kept.space + '_spacelink'}`
    expect(keptSpaceLink, "a KEPT space's own share link survives — this is #1's whole reason to ship first").toHaveLength(1)
    const tenantGrant = await admin<{ id: string }[]>`SELECT id FROM role_assignments WHERE id = 'ra_t810ed_tenant'`
    expect(tenantGrant, 'a tenant-tier grant is never collateral damage').toHaveLength(1)
    const [key] = await admin<{ space_ids: string[] }[]>`SELECT space_ids FROM api_keys WHERE id = 'key_t810ed'`
    expect(key.space_ids, 'api_keys.space_ids is left exactly as it was — meant to go stale, never swept').toEqual([doomed.space])
    const [template] = await admin<{ source_page_id: string; space_id: string; body_md: string }[]>`
      SELECT source_page_id, space_id, body_md FROM templates WHERE id = 'tpl_t810ed'`
    expect(template, 'a template survives its source page and space being gone — frozen snapshot, migration 051')
      .toEqual({ source_page_id: doomed.page, space_id: doomed.space, body_md: '# frozen' })
    const [spaceRow] = await admin<{ name: string }[]>`SELECT name FROM spaces WHERE id = ${kept.space}`
    expect(spaceRow, 'the kept space row itself survives').toBeDefined()

    const [progress] = await admin<{ database_done: boolean }[]>`SELECT database_done FROM tenant_sweep_progress WHERE manifest_id = ${manifestId}`
    expect(progress.database_done).toBe(true)
  })

  // ⚠️ break-check: prove the per-type ID matching actually matters, not just the resource_type filter
  // alone — this is the literal shape the original (pre-review) derive.ts comment told every consumer
  // was sufficient ("scope its DELETE to resource_type IN ('space', 'page')"), which review
  // c-a4180fb found would delete a KEPT space's own share link. Simulated directly against the fixture
  // (not a mutation of the shipped function, which already gets this right per the test above).
  it('⚠️ break-check: matching resource_type alone, with no id filter, WOULD delete the kept space\'s own share link', async () => {
    await seed()
    const typeOnlyMatch = await admin<{ id: string }[]>`
      SELECT id FROM share_links WHERE tenant_id = ${TENANT} AND resource_type IN ('space', 'page')`
    expect(typeOnlyMatch.map((r) => r.id), 'the exact defect the pre-review guidance would have produced').toContain(kept.space + '_spacelink')
  })
})

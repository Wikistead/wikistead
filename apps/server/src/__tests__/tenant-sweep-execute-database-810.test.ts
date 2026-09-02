// ADR-252 §1 / #810: executeDatabaseSweep — the first genuinely destructive step. Integration (real
// Postgres). This is the highest-stakes pin in this ticket: it is the one that actually deletes rows,
// so the fixture exercises every safety property named across this ticket's two independent design
// reviews:
//   - a KEPT space's row, settings (incl. icon key), and SPACE-level share link SURVIVE
//   - a KEPT space's PAGE (and everything cascading from it) is swept anyway (§1's corrected semantics)
//   - a TENANT-tier role_assignment is untouched (the polymorphic-table collateral-damage warning)
//   - api_keys.space_ids is left exactly as it was (meant to go stale, never swept)
//   - a template survives regardless of its source page/space (frozen snapshot, migration 051)
//   - a 'subtree' watch (resource_id = an ancestor PAGE id) is swept — D2, the hardcoded 'space'/'page'
//     literal vocabulary silently missed this resource_type entirely
//   - an in-flight import in the KEPT space, scoped to it ONLY via parent_page_id (not space_id), is
//     swept AND its archive_key is manifested — D1, the manifest query originally missed this exact
//     case (scoped by space_id alone) while the executor's own delete predicate already covered it,
//     which is precisely how a live orphaned S3 blob was produced and reproduced during review
//   - feed_events (page_id AND space_id both non-cascading, independently) is swept by both predicates
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { executeDatabaseSweep, UnclassifiableSchemaError, ManifestMismatchError } from '../tenant-sweep/execute-database.js'
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
    await admin`INSERT INTO space_settings (space_id, tenant_id, icon_image_key) VALUES (${s.space}, ${TENANT}, ${s.space + '/icon-key'})
      ON CONFLICT (space_id) DO UPDATE SET icon_image_key = EXCLUDED.icon_image_key`
    // SPACE-level share link — this is the safety property #1045's design review named by name
    await admin`INSERT INTO share_links (id, tenant_id, resource_type, resource_id, capability, created_by)
      VALUES (${s.space + '_spacelink'}, ${TENANT}, 'space', ${s.space}, 'view', 'user:dev-user') ON CONFLICT (id) DO NOTHING`
    // PAGE-level share link — swept regardless of kept/doomed (every page is swept)
    await admin`INSERT INTO share_links (id, tenant_id, resource_type, resource_id, capability, created_by)
      VALUES (${s.page + '_pagelink'}, ${TENANT}, 'page', ${s.page}, 'view', 'user:dev-user') ON CONFLICT (id) DO NOTHING`
    await admin`INSERT INTO feed_events (id, tenant_id, event_type, page_id, space_id, actor)
      VALUES (${s.page + '_feed'}, ${TENANT}, 'page.created', ${s.page}, ${s.space}, 'user:dev-user') ON CONFLICT (id) DO NOTHING`
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
  // a 'subtree' watch anchored on the DOOMED page — D2: silently un-swept under the old hardcoded
  // 'space'/'page' vocabulary; resource_id is a PAGE id (notifications.ts: "subtree anchors are pages")
  await admin`INSERT INTO watches (id, tenant_id, member_sub, resource_type, resource_id)
    VALUES ('w_t810ed_subtree', ${TENANT}, 'dev-user', 'subtree', ${doomed.page}) ON CONFLICT (id) DO NOTHING`
  // an in-flight import in the KEPT space, scoped ONLY by parent_page_id (not space_id) — D1: this is
  // exactly the row the manifest originally failed to record a storage key for
  await admin`INSERT INTO imports (id, tenant_id, space_id, executor_sub, parent_page_id, archive_key, status)
    VALUES ('import_t810ed_kept', ${TENANT}, ${kept.space}, 'user:dev-user', ${kept.page}, ${kept.space + '/archive-key'}, 'queued')
    ON CONFLICT (id) DO NOTHING`
}

afterAll(async () => {
  for (const tbl of ['templates', 'api_keys', 'role_assignments', 'roles', 'watches', 'imports', 'feed_events', 'share_links', 'attachments', 'space_settings', 'pages', 'spaces']) {
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

    // D1, pinned at the manifest level: the kept-space import's archive_key IS captured, reachable
    // only via parent_page_id since its space_id names the KEPT (never-in-doomed.spaceIds) space.
    const [manifest] = await admin<{ storage_keys: string[] }[]>`SELECT storage_keys FROM tenant_sweep_manifests WHERE id = ${manifestId}`
    expect(manifest.storage_keys, "the kept-space import's archive_key must be manifested before the sweep runs").toContain(kept.space + '/archive-key')

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
    const doomedSettings = await admin<{ space_id: string }[]>`SELECT space_id FROM space_settings WHERE space_id = ${doomed.space}`
    expect(doomedSettings, "the doomed space's settings row is swept").toEqual([])
    const remainingFeedEvents = await admin<{ id: string }[]>`SELECT id FROM feed_events WHERE tenant_id = ${TENANT}`
    expect(remainingFeedEvents, 'feed_events are swept for every page (both page_id and space_id predicates fire)').toEqual([])
    const subtreeWatch = await admin<{ id: string }[]>`SELECT id FROM watches WHERE id = 'w_t810ed_subtree'`
    expect(subtreeWatch, "D2: a 'subtree' watch anchored on the doomed page is swept, not silently left behind").toEqual([])
    const keptImport = await admin<{ id: string }[]>`SELECT id FROM imports WHERE id = 'import_t810ed_kept'`
    expect(keptImport, "D1: the kept-space import (reachable only via parent_page_id) is swept").toEqual([])

    // --- survives — the properties this ticket's reviews named ---
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
    const [keptSettings] = await admin<{ icon_image_key: string }[]>`SELECT icon_image_key FROM space_settings WHERE space_id = ${kept.space}`
    expect(keptSettings, "a KEPT space's settings row (and its icon key) survives — the row this ticket's fixture had never actually seeded until now").toEqual({ icon_image_key: kept.space + '/icon-key' })

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

  // ⚠️ break-check (D4, review c-af90ef9): the non-cascading DELETE loop had ZERO test
  // coverage — two independent mutations (wrong id set, and removing the loop entirely) both left the
  // ORIGINAL fixture's 27/27 tests green, because nothing in it was reachable only through that loop.
  // imports/feed_events/watches above close that gap for the happy-path test; this proves it by
  // showing the loop is what deletes them, not an accident of some other statement.
  it('⚠️ break-check: skipping the non-cascading DELETE loop leaves imports/feed_events/subtree-watch behind', async () => {
    await seed()
    const { manifestId, doomed: doomedIds } = await writeResetManifest(admin, TENANT, [kept.space])
    // Run only the row-delete tail of the sweep (pages, spaces) — the shape the executor would have if
    // the non-cascading loop were deleted entirely — directly against the fixture, not the shipped
    // function (which already includes the loop, per the happy-path test above).
    await admin.begin(async (tx) => {
      await tx`DELETE FROM pages WHERE tenant_id = ${TENANT} AND id = ANY(${[...doomedIds.pageIds]})`
      await tx`DELETE FROM spaces WHERE tenant_id = ${TENANT} AND id = ANY(${[...doomedIds.spaceIds]})`
    })
    const survivingImport = await admin<{ id: string }[]>`SELECT id FROM imports WHERE id = 'import_t810ed_kept'`
    const survivingWatch = await admin<{ id: string }[]>`SELECT id FROM watches WHERE id = 'w_t810ed_subtree'`
    const survivingFeed = await admin<{ id: string }[]>`SELECT id FROM feed_events WHERE tenant_id = ${TENANT}`
    expect(survivingImport, 'without the non-cascading loop, this row has no FK to remove it').toHaveLength(1)
    expect(survivingWatch, 'without the polymorphic sweep, the subtree watch has no FK to remove it either').toHaveLength(1)
    expect(survivingFeed.length, 'feed_events has no FK to spaces/pages at all').toBeGreaterThan(0)
    // cleanup: the sweep itself never ran, so finish it via the real function for the next test's afterAll
    await executeDatabaseSweep(admin, manifestId, TENANT, doomedIds).catch(() => {}) // best-effort, rows may already be gone
  })

  it('refuses a manifest for a different tenant (ManifestMismatchError, thrown before any DELETE)', async () => {
    await seed()
    const { manifestId, doomed: doomedIds } = await writeResetManifest(admin, TENANT, [kept.space])
    await expect(executeDatabaseSweep(admin, manifestId, 'tenant_some_other_tenant', doomedIds)).rejects.toThrow(ManifestMismatchError)
    // nothing was touched — the mismatch was caught before the transaction opened
    const stillThere = await admin<{ id: string }[]>`SELECT id FROM pages WHERE tenant_id = ${TENANT}`
    expect(stillThere.length).toBeGreaterThan(0)
    await executeDatabaseSweep(admin, manifestId, TENANT, doomedIds) // finish it for afterAll
  })

  it('refuses an unknown manifest id (ManifestMismatchError)', async () => {
    await expect(executeDatabaseSweep(admin, 'not-a-real-manifest-id', TENANT, { spaceIds: [], pageIds: [] })).rejects.toThrow(ManifestMismatchError)
  })

  // UnclassifiableSchemaError's own throw sites are unreachable against today's real schema (nothing
  // to classify wrongly) — its reachability is pinned structurally instead, via
  // deriveNonCascadingColumns' ambiguousColumns break-check in tenant-sweep-derive-810.test.ts, which
  // proves the INPUT this class exists to report is itself producible. Referenced here so the import
  // in this file (previously dead per review c-af90ef9's D5) is load-bearing.
  it('UnclassifiableSchemaError is a real Error subclass carrying its reasons', () => {
    const err = new UnclassifiableSchemaError(['x.y: reason'])
    expect(err).toBeInstanceOf(Error)
    expect(err.reasons).toEqual(['x.y: reason'])
    expect(err.message).toContain('x.y: reason')
  })
})

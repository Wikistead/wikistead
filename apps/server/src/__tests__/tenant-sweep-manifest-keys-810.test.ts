// ADR-252 §1 / #810: collectResetStorageKeys — every S3 key belonging to spaces/pages a reset is
// about to empty. Integration (real Postgres): builds a tenant with ONE kept space and ONE doomed
// space, each carrying an attachment, a revision blob and a space icon, plus an import archive.
//
// ⚠️ §1's own words: "for a kept space it keeps the space, its settings, and its share links; it
// EMPTIES THE PAGES INSIDE" — a kept space's pages are swept too, only its space row/settings/share
// links survive. So `kept.page`'s attachment/revision keys belong in the expected set (they ARE
// swept); only `kept.space`'s icon key and import archive should be ABSENT (its settings survive).
// A test that excluded the kept space from BOTH id sets would not be testing reset's real shape —
// it would be testing "an untouched space", a scenario reset never has when a keep-list is given.
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { collectResetStorageKeys } from '../tenant-sweep/manifest-keys.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_t810mk'

afterAll(async () => {
  for (const tbl of ['attachments', 'revisions', 'space_settings', 'imports', 'pages', 'spaces']) {
    await admin.unsafe(`DELETE FROM ${tbl} WHERE tenant_id = '${TENANT}'`).catch(() => {})
  }
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await admin.end()
})

describe('collectResetStorageKeys (ADR-252 §1, #810)', () => {
  it('collects a kept space\'s PAGE keys (pages are swept regardless) but not its SPACE-level keys (settings survive)', async () => {
    await admin`INSERT INTO tenants (id, slug, plan) VALUES (${TENANT}, 't810mk', 'business')
      ON CONFLICT (slug) DO UPDATE SET plan = EXCLUDED.plan`

    const kept = { space: 'space_t810mk_kept', page: 'page_t810mk_kept' }
    const doomed = { space: 'space_t810mk_doomed', page: 'page_t810mk_doomed' }

    for (const s of [kept, doomed]) {
      await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${s.space}, ${TENANT}, ${s.space})
        ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc)
        VALUES (${s.page}, ${TENANT}, ${s.space}, ${s.page}, ${Buffer.from([])})
        ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO attachments (id, tenant_id, page_id, filename, content_type, size_bytes, s3_key, status)
        VALUES (${s.page + '_att'}, ${TENANT}, ${s.page}, 'f.png', 'image/png', 10, ${s.space + '/att-key'}, 'confirmed')
        ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO revisions (id, tenant_id, page_id, title, created_by, ydoc_key)
        VALUES (${s.page + '_rev'}, ${TENANT}, ${s.page}, ${s.page}, 'user:dev-user', ${s.space + '/rev-key'})
        ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO space_settings (space_id, tenant_id, icon_image_key)
        VALUES (${s.space}, ${TENANT}, ${s.space + '/icon-key'})
        ON CONFLICT (space_id) DO UPDATE SET icon_image_key = EXCLUDED.icon_image_key`
    }
    await admin`INSERT INTO imports (id, tenant_id, space_id, executor_sub, archive_key)
      VALUES (${'import_t810mk_doomed'}, ${TENANT}, ${doomed.space}, 'user:dev-user', ${doomed.space + '/archive-key'})
      ON CONFLICT (id) DO NOTHING`
    await admin`INSERT INTO imports (id, tenant_id, space_id, executor_sub, archive_key)
      VALUES (${'import_t810mk_kept'}, ${TENANT}, ${kept.space}, 'user:dev-user', ${kept.space + '/archive-key'})
      ON CONFLICT (id) DO NOTHING`

    // reset's real shape: BOTH pages are emptied (kept.page included in pageIds); only the DOOMED
    // space's own id is in spaceIds (kept.space's settings/icon/import-archive must survive)
    const keys = await collectResetStorageKeys(admin, TENANT, {
      spaceIds: [doomed.space],
      pageIds: [doomed.page, kept.page],
    })

    expect(keys.sort()).toEqual([
      `${doomed.space}/archive-key`,
      `${doomed.space}/att-key`,
      `${doomed.space}/icon-key`,
      `${doomed.space}/rev-key`,
      `${kept.space}/att-key`,
      `${kept.space}/rev-key`,
    ].sort())
    // the kept space's SETTINGS-level keys (icon, import archive) must never appear — those are the
    // ones a kept space's survival actually protects
    expect(keys).not.toContain(`${kept.space}/icon-key`)
    expect(keys).not.toContain(`${kept.space}/archive-key`)
  })

  it('returns an empty list for an empty doomed set (nothing to sweep)', async () => {
    const keys = await collectResetStorageKeys(admin, TENANT, { spaceIds: [], pageIds: [] })
    expect(keys).toEqual([])
  })
})

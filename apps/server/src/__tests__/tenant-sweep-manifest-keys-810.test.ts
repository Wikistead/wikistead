// ADR-252 §1 / #810: collectResetStorageKeys — every S3 key belonging to spaces/pages a reset is
// about to empty. Integration (real Postgres): builds a tenant with ONE kept space and ONE doomed
// space, each carrying an attachment, a revision blob and a space icon, plus a doomed import archive —
// and asserts the kept space's keys are absent while the doomed space's are all present. The point of
// this pin is exactly that boundary: a function that returned every key in the tenant would pass any
// test that only checks presence, never absence.
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
  it('collects the doomed space/page keys and none of the kept space/page keys', async () => {
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

    const keys = await collectResetStorageKeys(admin, TENANT, { spaceIds: [doomed.space], pageIds: [doomed.page] })

    expect(keys.sort()).toEqual([
      `${doomed.space}/archive-key`,
      `${doomed.space}/att-key`,
      `${doomed.space}/icon-key`,
      `${doomed.space}/rev-key`,
    ].sort())
    for (const k of keys) expect(k.startsWith(kept.space), `leaked a kept-space key: ${k}`).toBe(false)
  })

  it('returns an empty list for an empty doomed set (no keep-list means nothing to reset here)', async () => {
    const keys = await collectResetStorageKeys(admin, TENANT, { spaceIds: [], pageIds: [] })
    expect(keys).toEqual([])
  })
})

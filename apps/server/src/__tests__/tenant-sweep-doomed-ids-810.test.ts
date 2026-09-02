// ADR-252 §1 / #810: computeDoomedIds — turns an operator's keep-list into the DoomedIds every
// collection function in this directory consumes. Integration (real Postgres): a tenant with 2
// spaces (one on the keep-list, one not), each with a page, plus a TRASHED page in the kept space.
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { computeDoomedIds } from '../tenant-sweep/doomed-ids.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_t810di'

afterAll(async () => {
  for (const tbl of ['pages', 'spaces']) await admin.unsafe(`DELETE FROM ${tbl} WHERE tenant_id = '${TENANT}'`).catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await admin.end()
})

describe('computeDoomedIds (ADR-252 §1, #810)', () => {
  it('with a keep-list: kept space is excluded from spaceIds, but ALL pages (including trashed, including the kept space\'s) are in pageIds', async () => {
    await admin`INSERT INTO tenants (id, slug, plan) VALUES (${TENANT}, 't810di', 'business')
      ON CONFLICT (slug) DO UPDATE SET plan = EXCLUDED.plan`
    const kept = 'space_t810di_kept'
    const doomed = 'space_t810di_doomed'
    for (const s of [kept, doomed]) {
      await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${s}, ${TENANT}, ${s}) ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc) VALUES (${s + '_page'}, ${TENANT}, ${s}, ${s}, ${Buffer.from([])}) ON CONFLICT (id) DO NOTHING`
    }
    // a TRASHED page in the KEPT space — must still appear in pageIds
    await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc, deleted_at)
      VALUES (${kept + '_trashed'}, ${TENANT}, ${kept}, 'trashed', ${Buffer.from([])}, now())
      ON CONFLICT (id) DO NOTHING`

    const result = await computeDoomedIds(admin, TENANT, [kept])
    expect(result.spaceIds).toEqual([doomed])
    expect([...result.pageIds].sort()).toEqual([kept + '_page', kept + '_trashed', doomed + '_page'].sort())
  })

  it('with an empty keep-list: every space is doomed (a full reset)', async () => {
    const result = await computeDoomedIds(admin, TENANT, [])
    expect([...result.spaceIds].sort()).toEqual(['space_t810di_doomed', 'space_t810di_kept'])
  })

  // ⚠️ break-check: prove the keep-list actually excludes something, not that the fixture happens to
  // produce the same result either way.
  it('⚠️ break-check: WITHOUT the keep-list the kept space WOULD be in spaceIds', async () => {
    const withKeepList = await computeDoomedIds(admin, TENANT, ['space_t810di_kept'])
    const withoutKeepList = await computeDoomedIds(admin, TENANT, [])
    expect(withKeepList.spaceIds).not.toContain('space_t810di_kept')
    expect(withoutKeepList.spaceIds).toContain('space_t810di_kept')
  })
})

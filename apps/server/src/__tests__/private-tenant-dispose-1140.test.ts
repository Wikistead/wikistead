// #1140: `privateTenant()`'s dispose() used a hand-kept table list that left out spaces/pages/
// share_links/tenant_settings/member_identities (among others), and swallowed the final
// `DELETE FROM tenants` failure with `.catch(() => {})`. A tenant that failed to fully dispose was
// silently REUSED by the next run (same `tenant_<slug>` id, `ON CONFLICT (slug) DO UPDATE`), with
// whatever rows and settings the failed run left behind still attached — exactly the state that made
// #1127's break-check false-pass (a stale row from a PRIOR run answered the assertion, not the row
// this run's own seed step wrote).
//
// This pin proves two things real usage depends on: (1) dispose() actually clears tables the old
// list never named, using the same "ask the database, don't hand-list" derivation
// `infra/db/prune-test-tenants.ts` (#788) already uses for the whole-tenant case; (2) a dispose that
// cannot fully clear a tenant THROWS instead of leaving the tenant row (and the next run's fixture)
// silently corrupted.
import { describe, it, expect, afterEach } from 'vitest'
import postgres from 'postgres'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)

let pt: PrivateTenant | undefined

afterEach(async () => {
  // Best-effort: if a test's own dispose() call already succeeded (or deliberately failed, for the
  // throw case), there is nothing more to release. Guards a leak if an assertion above throws first.
  if (pt) await admin`DELETE FROM tenants WHERE id = ${pt.id}`.catch(() => {})
  pt = undefined
})

describe('#1140: privateTenant().dispose() clears every table the schema says is tenant-scoped', () => {
  it('a space, a page, a share_link and a tenant_settings row — none named by the old hand-kept list — are all gone after dispose()', async () => {
    pt = await privateTenant(admin, `t1140a-${STAMP}`)
    const { id } = pt

    const [space] = await admin<{ id: string }[]>`
      INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${id}, 'Space')
      RETURNING id`
    const [page] = await admin<{ id: string }[]>`
      INSERT INTO pages (id, tenant_id, space_id, title)
      VALUES (gen_random_uuid()::text, ${id}, ${space.id}, 'Page')
      RETURNING id`
    await admin`
      INSERT INTO share_links (id, tenant_id, resource_type, resource_id, capability, created_by)
      VALUES (gen_random_uuid()::text, ${id}, 'page', ${page.id}, 'viewer', 'dev-user')`
    await admin`
      INSERT INTO tenant_settings (tenant_id, abuse_banned_words)
      VALUES (${id}, '{}')
      ON CONFLICT (tenant_id) DO NOTHING`

    await pt.dispose()
    const disposed = pt
    pt = undefined // disposed already — afterEach must not try again

    const counts = await admin<{ table_name: string; n: number }[]>`
      SELECT 'spaces' AS table_name, count(*)::int AS n FROM spaces WHERE tenant_id = ${disposed.id}
      UNION ALL SELECT 'pages', count(*)::int FROM pages WHERE tenant_id = ${disposed.id}
      UNION ALL SELECT 'share_links', count(*)::int FROM share_links WHERE tenant_id = ${disposed.id}
      UNION ALL SELECT 'tenant_settings', count(*)::int FROM tenant_settings WHERE tenant_id = ${disposed.id}
      UNION ALL SELECT 'tenants', count(*)::int FROM tenants WHERE id = ${disposed.id}`
    for (const row of counts) expect(row.n, `${row.table_name} still has a row for the disposed tenant`).toBe(0)
  })
})

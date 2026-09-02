// Tenant sweep manifest + progress tables (migration 135, ADR-252 §1/"Both operations", #810) —
// integration (real Postgres). This is infrastructure only: the manifest and progress record are the
// durable pre-destruction index the sweep (§1 tenant:reset, ships first — not yet implemented) writes
// before it destroys anything. Verifies the isolation shape these tables MUST have, mirroring
// operator_audit_log's own pin (operator-ledger.test.ts): the tenant `app` role gets no grants at all
// (RLS forced, no policy), and only the admin/operator connection the sweep runs with can touch them —
// because a tenant-scoped role reading its own removal manifest mid-sweep is exactly the kind of leak
// ADR-252 names ("the manifest is an index of what a removed workspace called its files").
import { describe, it, expect, afterAll, afterEach } from 'vitest'
import postgres from 'postgres'

const admin = postgres(process.env.DATABASE_ADMIN_URL!) // superuser / BYPASSRLS (the sweep's own connection)
const appRole = postgres(process.env.DATABASE_URL!) // restricted runtime role (NOBYPASSRLS)

const probeIds: string[] = []
afterEach(async () => {
  if (probeIds.length === 0) return
  await admin`DELETE FROM tenant_sweep_progress WHERE manifest_id = ANY(${probeIds})`
  await admin`DELETE FROM tenant_sweep_manifests WHERE id = ANY(${probeIds})`
  probeIds.length = 0
})
afterAll(async () => { await admin.end(); await appRole.end() })

describe('tenant_sweep_manifests / tenant_sweep_progress (migration 135, #810)', () => {
  it('the tenant (app) role CANNOT read or write either table (operator-only isolation)', async () => {
    await expect(appRole`SELECT id FROM tenant_sweep_manifests LIMIT 1`).rejects.toThrow(/permission denied/i)
    await expect(appRole`INSERT INTO tenant_sweep_manifests (tenant_id, operation, fga_object_ids, storage_keys, search_document_ids)
      VALUES ('probe', 'reset', '{}', '{}', '{}')`).rejects.toThrow(/permission denied/i)
    await expect(appRole`SELECT manifest_id FROM tenant_sweep_progress LIMIT 1`).rejects.toThrow(/permission denied/i)
  })

  it('the admin connection can write and read a manifest and its progress row', async () => {
    const [m] = await admin<{ id: string }[]>`INSERT INTO tenant_sweep_manifests
      (tenant_id, operation, keep_space_ids, fga_object_ids, storage_keys, search_document_ids)
      VALUES ('probe-810', 'reset', ${['space:kept']}, ${['tenant:probe-810']}, ${[]}, ${[]}) RETURNING id`
    probeIds.push(m.id)
    const [p] = await admin<{ manifest_id: string; database_done: boolean }[]>`
      INSERT INTO tenant_sweep_progress (manifest_id) VALUES (${m.id}) RETURNING manifest_id, database_done`
    expect(p.manifest_id).toBe(m.id)
    expect(p.database_done).toBe(false) // every step starts unfinished

    const [read] = await admin<{ tenant_id: string; keep_space_ids: string[] }[]>`
      SELECT tenant_id, keep_space_ids FROM tenant_sweep_manifests WHERE id = ${m.id}`
    expect(read).toMatchObject({ tenant_id: 'probe-810', keep_space_ids: ['space:kept'] })
  })

  it('rejects an operation value outside reset|remove (CHECK constraint)', async () => {
    await expect(admin`INSERT INTO tenant_sweep_manifests
      (tenant_id, operation, fga_object_ids, storage_keys, search_document_ids)
      VALUES ('probe-810-bad', 'destroy', '{}', '{}', '{}')`).rejects.toThrow(/check constraint/i)
  })

  // ⚠️ break-check: prove the isolation pin actually distinguishes the two roles, not merely that
  // `app` gets an error for an unrelated reason (a typo'd table name would also throw).
  it('⚠️ break-check: the admin connection is NOT itself refused by the same query the app role failed', async () => {
    await expect(admin`SELECT id FROM tenant_sweep_manifests LIMIT 1`).resolves.toBeDefined()
  })
})

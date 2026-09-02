// ADR-252 §1 / #810: executeFgaSweep — the OpenFGA step. Integration (real Postgres + real FGA
// store). Verifies: every object the manifest names has its tuples cleared, an object NOT in the
// manifest (simulating a kept space's own object) is untouched, and the step is idempotent (running
// it twice is not an error, the second run just clears nothing more).
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { fgaClient, writeTuples, readObjectTuples, deleteObjectTuples } from '@wikistead/authz'
import { executeFgaSweep } from '../tenant-sweep/execute-fga.js'
import { ManifestMismatchError } from '../tenant-sweep/execute-database.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_t810fg'

async function seedManifest(fgaObjectIds: string[]): Promise<string> {
  await admin`INSERT INTO tenants (id, slug, plan) VALUES (${TENANT}, 't810fg', 'business')
    ON CONFLICT (slug) DO UPDATE SET plan = EXCLUDED.plan`
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO tenant_sweep_manifests (tenant_id, operation, fga_object_ids, storage_keys, search_document_ids)
    VALUES (${TENANT}, 'reset', ${fgaObjectIds}, ${[]}, ${[]}) RETURNING id`
  await admin`INSERT INTO tenant_sweep_progress (manifest_id) VALUES (${row.id})`
  return row.id
}

afterAll(async () => {
  await admin`DELETE FROM tenant_sweep_progress WHERE manifest_id IN (SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT})`.catch(() => {})
  await admin`DELETE FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await admin.end()
})

describe('executeFgaSweep (ADR-252 §1, #810)', () => {
  it('clears every manifested object\'s tuples, leaves an unmentioned (kept-space) object untouched', async () => {
    const doomedSpace = 'space:t810fg-doomed'
    const doomedPage = 'page:t810fg-doomed-page'
    const keptSpace = 'space:t810fg-kept' // NOT in the manifest — simulates a kept space's own object
    await writeTuples(fgaClient, [
      { user: 'user:dev-user', relation: 'manager', object: doomedSpace },
      { user: 'user:dev-user', relation: 'manage_direct', object: doomedPage },
      { user: doomedSpace, relation: 'space', object: doomedPage },
      { user: 'user:dev-user', relation: 'manager', object: keptSpace },
    ])
    const manifestId = await seedManifest([doomedSpace, doomedPage])

    await executeFgaSweep(admin, fgaClient, manifestId, TENANT)

    expect(await readObjectTuples(fgaClient, doomedSpace), 'the doomed space object has no tuples left').toEqual([])
    expect(await readObjectTuples(fgaClient, doomedPage), 'the doomed page object has no tuples left').toEqual([])
    const keptTuples = await readObjectTuples(fgaClient, keptSpace)
    expect(keptTuples, "an object NOT in the manifest (the kept space's own) is untouched").toHaveLength(1)

    const [progress] = await admin<{ fga_done: boolean }[]>`SELECT fga_done FROM tenant_sweep_progress WHERE manifest_id = ${manifestId}`
    expect(progress.fga_done).toBe(true)

    // idempotent: running it again is not an error, and the kept object is still untouched
    await executeFgaSweep(admin, fgaClient, manifestId, TENANT)
    expect(await readObjectTuples(fgaClient, keptSpace)).toHaveLength(1)

    // cleanup the survivor (this file's own fixture, not the sweep's job)
    await deleteObjectTuples(fgaClient, keptSpace)
  })

  it('refuses a manifest for a different tenant, and an unknown manifest id', async () => {
    const manifestId = await seedManifest([])
    await expect(executeFgaSweep(admin, fgaClient, manifestId, 'tenant_some_other_tenant')).rejects.toThrow(ManifestMismatchError)
    await expect(executeFgaSweep(admin, fgaClient, 'not-a-real-manifest-id', TENANT)).rejects.toThrow(ManifestMismatchError)
  })
})

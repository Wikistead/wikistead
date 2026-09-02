// ADR-252 §1 / #810: runResetSweep — the orchestrator over the four built store-steps. Integration
// (real Postgres + real FGA + real Meilisearch + real object storage).
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { fgaClient, writeTuples, readObjectTuples, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { runResetSweep } from '../tenant-sweep/run-sweep.js'
import { writeResetManifest } from '../tenant-sweep/write-manifest.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const search = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const TENANT = 'tenant_t810rs'
const doomedSpace = 'space_t810rs_doomed'
const doomedPage = 'page_t810rs_doomed'

async function seed(): Promise<void> {
  await admin`INSERT INTO tenants (id, slug, plan) VALUES (${TENANT}, 't810rs', 'business')
    ON CONFLICT (slug) DO UPDATE SET plan = EXCLUDED.plan`
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${doomedSpace}, ${TENANT}, ${doomedSpace}) ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc) VALUES (${doomedPage}, ${TENANT}, ${doomedSpace}, 't810rs-title', ${Buffer.from([])}) ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO attachments (id, tenant_id, page_id, filename, content_type, size_bytes, s3_key, status)
    VALUES ('att_t810rs', ${TENANT}, ${doomedPage}, 'f.png', 'image/png', 10, 't810rs/att-key', 'confirmed') ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, [{ user: 'user:dev-user', relation: 'manager', object: `space:${doomedSpace}` }])
  await search.upsertDoc({
    id: doomedPage, tenantId: TENANT, spaceId: doomedSpace, title: 't810rs-title',
    body: '', viewerUsers: ['user:dev-user'], viewerGroups: [], isPublic: false, updatedAt: Date.now(),
  })
  await storage.putObject('t810rs/manual-key', new TextEncoder().encode('bytes'), 'text/plain')
}

afterAll(async () => {
  for (const tbl of ['attachments', 'pages', 'spaces']) await admin.unsafe(`DELETE FROM ${tbl} WHERE tenant_id = '${TENANT}'`).catch(() => {})
  await admin`DELETE FROM tenant_sweep_progress WHERE manifest_id IN (SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT})`.catch(() => {})
  await admin`DELETE FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await deleteObjectTuples(fgaClient, `space:${doomedSpace}`).catch(() => {})
  await storage.deleteObject('t810rs/manual-key').catch(() => {})
  await admin.end()
})

describe('runResetSweep (ADR-252 §1, #810)', () => {
  it('runs all four steps and marks all four progress flags — the manifest is NOT deleted (sessions is not built)', async () => {
    await seed()
    const { manifestId, doomed } = await writeResetManifest(admin, TENANT, [])

    await runResetSweep(admin, { fga: fgaClient, search, storage }, manifestId, TENANT, doomed)

    const [progress] = await admin<{ database_done: boolean; fga_done: boolean; search_done: boolean; storage_done: boolean; sessions_done: boolean }[]>`
      SELECT database_done, fga_done, search_done, storage_done, sessions_done FROM tenant_sweep_progress WHERE manifest_id = ${manifestId}`
    expect(progress).toMatchObject({ database_done: true, fga_done: true, search_done: true, storage_done: true, sessions_done: false })

    const [manifestStillThere] = await admin<{ id: string }[]>`SELECT id FROM tenant_sweep_manifests WHERE id = ${manifestId}`
    expect(manifestStillThere, 'the manifest survives — §6b (sessions) is proposed, not built, so the sweep is never "every store verified"').toBeDefined()

    const remainingPage = await admin<{ id: string }[]>`SELECT id FROM pages WHERE id = ${doomedPage}`
    expect(remainingPage).toEqual([])
  })

  it('skips a step already marked done, even when its target would otherwise still be swept', async () => {
    await seed()
    const { manifestId } = await writeResetManifest(admin, TENANT, [])
    // simulate a prior partial run that marked the DATABASE step done without actually running it —
    // the orchestrator must trust the flag and skip, not re-derive "is it really done" itself
    await admin`UPDATE tenant_sweep_progress SET database_done = true WHERE manifest_id = ${manifestId}`

    await runResetSweep(admin, { fga: fgaClient, search, storage }, manifestId, TENANT, { spaceIds: [doomedSpace], pageIds: [doomedPage] })

    // the database step was SKIPPED — the page (which a real database sweep would have deleted) survives
    const stillThere = await admin<{ id: string }[]>`SELECT id FROM pages WHERE id = ${doomedPage}`
    expect(stillThere, 'skipped because database_done was already true, even though the row was never actually swept').toHaveLength(1)

    // but the other three steps DID run
    const [progress] = await admin<{ fga_done: boolean; search_done: boolean; storage_done: boolean }[]>`
      SELECT fga_done, search_done, storage_done FROM tenant_sweep_progress WHERE manifest_id = ${manifestId}`
    expect(progress).toEqual({ fga_done: true, search_done: true, storage_done: true })
    expect(await readObjectTuples(fgaClient, `space:${doomedSpace}`)).toEqual([])
  })
})

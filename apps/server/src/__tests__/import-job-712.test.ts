// #712 / ADR-227 §7 — import escalates to a background job above the threshold.
//
// What §7 is FOR: a big import that finishes after the client's connection died must still leave its
// report somewhere the person can read. So the measurements here are about the SEAM, not about
// Markdown: the threshold decides sync vs job, the job creates the same pages the sync path would, the
// report survives in the row, a second import for the same space is refused, and the status surface
// does not answer for another space.
//
// The archives are pushed through the SHIPPED route (`POST /spaces/:spaceId/import`), because the
// thing being tested is a decision the route makes. The drain is driven directly — the worker that
// calls it on a timer starts from the server entry, which inject-driven tests do not run (#432).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { zipSync, strToU8 } from 'fflate'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { IMPORT_SYNC_MAX_NODES, drainImportJobsInScope, readImportStatus } from '../import/jobs.js'
import { privateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const USER = 'dev-user'
const STRANGER = 'imp712-stranger'

let app: FastifyInstance
let TENANT: string
let SPACE: string
let OTHER_SPACE: string
let dispose: () => Promise<void>
let H: { host: string; authorization: string; 'content-type': string }

// A vault whose size is what is under test: `n` notes, each trivially small, so the only thing that
// crosses the threshold is the NODE COUNT — which is what §7 measures against.
function vaultOf(n: number, prefix: string): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  for (let i = 0; i < n; i++) files[`${prefix} ${String(i).padStart(4, '0')}.md`] = strToU8(`# ${prefix} ${i}\n\nBody ${i}.\n`)
  // One shape the importer cannot represent, so the job's report has something to NAME. A report that
  // survives the connection but says nothing would satisfy §7's letter and none of its purpose.
  files[`${prefix} board.canvas`] = strToU8('{"nodes":[],"edges":[]}')
  return zipSync(files)
}

const post = (spaceId: string, zip: Uint8Array) =>
  app.inject({
    method: 'POST', url: `/spaces/${spaceId}/import`, headers: H,
    payload: { zipBase64: Buffer.from(zip).toString('base64') },
  })

const drain = () => drainImportJobsInScope({ fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() })

beforeAll(async () => {
  const t = await privateTenant(admin, 'imp712')
  TENANT = t.id
  dispose = t.dispose
  H = t.H
  app = await buildApp(); await app.ready()
  const [space] = await admin<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${TENANT}, 'Job target') RETURNING id`
  SPACE = space!.id
  const [other] = await admin<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${TENANT}, 'Somewhere else') RETURNING id`
  OTHER_SPACE = other!.id
  // The slug is fixed, so a run that died before afterAll leaves rows behind and the counts below
  // would measure the previous run (the lesson the Obsidian suite already paid for).
  await admin`DELETE FROM pages WHERE tenant_id = ${TENANT}`
  await admin`DELETE FROM imports WHERE tenant_id = ${TENANT}`
  await writeTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${SPACE}` },
    { user: `user:${USER}`, relation: 'manager', object: `space:${SPACE}` },
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${OTHER_SPACE}` },
  ])
}, 300_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${SPACE}` },
    { user: `user:${USER}`, relation: 'manager', object: `space:${SPACE}` },
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${OTHER_SPACE}` },
  ]).catch(() => {})
  await admin`DELETE FROM imports WHERE tenant_id = ${TENANT}`.catch(() => {})
  await app.close()
  await dispose?.()
  await pool.end(); await admin.end()
}, 300_000)

describe('#712 §7: the threshold decides whether one request can carry the import', () => {
  it('stays synchronous below the threshold — the existing path, unchanged', async () => {
    const res = await post(SPACE, vaultOf(3, 'small'))
    expect(res.statusCode, 'a small vault still answers with its report').toBe(200)
    const report = res.json()
    expect(report.pagesCreated).toBe(3)
    const [{ count }] = await admin<{ count: string }[]>`SELECT count(*)::text FROM imports WHERE tenant_id = ${TENANT}`
    expect(count, 'nothing was queued — a small import never becomes a job').toBe('0')
  }, 300_000)

  it('escalates above the threshold: 202 first, pages only after the drain, report in the row', async () => {
    const before = await admin<{ count: string }[]>`SELECT count(*)::text AS count FROM pages WHERE tenant_id = ${TENANT}`
    const n = IMPORT_SYNC_MAX_NODES + 1
    const res = await post(SPACE, vaultOf(n, 'big'))
    expect(res.statusCode, 'too big for one request → 202').toBe(202)
    const { importId, nodesTotal } = res.json()
    expect(nodesTotal, 'the count that crossed the threshold is the count in the archive').toBe(n)

    // The 202 means "accepted", and the difference from the synchronous path is that it has NOT run.
    const mid = await admin<{ count: string }[]>`SELECT count(*)::text AS count FROM pages WHERE tenant_id = ${TENANT}`
    expect(mid[0]!.count, 'the request created no pages').toBe(before[0]!.count)
    const queued = await readImportStatus({ id: importId, tenantId: TENANT, spaceId: SPACE })
    expect(queued?.status).toBe('queued')

    expect(await drain(), 'the drain picked the job up').toBe(1)

    const done = await readImportStatus({ id: importId, tenantId: TENANT, spaceId: SPACE })
    expect(done?.status, 'the job ran to completion').toBe('done')
    expect(done?.report?.pagesCreated, 'the job created what the archive held').toBe(n)
    expect(done?.nodesDone).toBe(n)
    const after = await admin<{ count: string }[]>`SELECT count(*)::text AS count FROM pages WHERE tenant_id = ${TENANT}`
    expect(Number(after[0]!.count) - Number(before[0]!.count), 'the pages are real').toBe(n)

    // The whole reason §7 exists: the report is readable from a connection that never saw the import.
    const status = await app.inject({ method: 'GET', url: `/spaces/${SPACE}/imports/${importId}`, headers: H })
    expect(status.statusCode).toBe(200)
    expect(status.json().report.pagesCreated, 'the report outlived the request that started it').toBe(n)
    // …and it is a REPORT, not a quoted blob. Measured: the pool hands JSONB back as a string, so the
    // degraded list arrived as text and every read of it was silently undefined — a fidelity report
    // that names nothing is the exact failure ADR-227 exists to prevent.
    const degraded = status.json().report.degraded
    expect(Array.isArray(degraded), 'the report survives as structure, not as text').toBe(true)
    expect(degraded.map((d: { what: string }) => d.what).join(' '), 'the canvas is named, not silently absent')
      .toMatch(/canvas/i)

    // Nothing lands published (ADR-132's draft default holds across the job boundary too).
    const [{ published }] = await admin<{ published: string }[]>`
      SELECT count(*)::text AS published FROM pages WHERE tenant_id = ${TENANT} AND published_at IS NOT NULL`
    expect(published, 'a job import publishes nothing either').toBe('0')
  }, 600_000)

  it('refuses a second import for the same space while one is pending (409), and frees the slot when it settles', async () => {
    const first = await post(SPACE, vaultOf(IMPORT_SYNC_MAX_NODES + 1, 'race-a'))
    expect(first.statusCode).toBe(202)
    const second = await post(SPACE, vaultOf(IMPORT_SYNC_MAX_NODES + 1, 'race-b'))
    expect(second.statusCode, 'one import per space — the second is refused, not queued behind it').toBe(409)
    // A DIFFERENT space is not blocked by it: the bound is per space, not per tenant.
    const elsewhere = await post(OTHER_SPACE, vaultOf(IMPORT_SYNC_MAX_NODES + 1, 'race-c'))
    expect(elsewhere.statusCode, 'another space may still start one').toBe(202)

    await drain(); await drain()
    const third = await post(SPACE, vaultOf(IMPORT_SYNC_MAX_NODES + 1, 'race-d'))
    expect(third.statusCode, 'a settled import releases the slot').toBe(202)
    await drain()
  }, 600_000)

  it('gates the 202 on space edit — a member who cannot write here cannot park an archive', async () => {
    const [space] = await admin<{ id: string }[]>`
      INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${TENANT}, 'Not yours') RETURNING id`
    const forbidden = space!.id
    // dev-user holds NO tuple on this space. The synchronous path would have been stopped inside
    // createPage; the job path returns before that ever runs, so the gate has to be at the door.
    const res = await post(forbidden, vaultOf(IMPORT_SYNC_MAX_NODES + 1, 'nope'))
    expect(res.statusCode, 'no space edit → 403').toBe(403)
    const [{ count }] = await admin<{ count: string }[]>`
      SELECT count(*)::text FROM imports WHERE tenant_id = ${TENANT} AND space_id = ${forbidden}`
    expect(count, 'and nothing was queued or staged').toBe('0')
    await admin`DELETE FROM spaces WHERE id = ${forbidden}`
  }, 300_000)

  it('the status row does not answer for another space, and 404s rather than confirming it exists', async () => {
    const res = await post(SPACE, vaultOf(IMPORT_SYNC_MAX_NODES + 1, 'scoped'))
    expect(res.statusCode).toBe(202)
    const { importId } = res.json()

    // `imports` carries no RLS (it is a drained queue), so the tenant/space match is an explicit
    // predicate — this is the test that keeps it honest. Asking through a space the caller CAN edit,
    // for an import that belongs to a different one, must not reveal it.
    const crossSpace = await app.inject({ method: 'GET', url: `/spaces/${OTHER_SPACE}/imports/${importId}`, headers: H })
    expect(crossSpace.statusCode, 'the row belongs to another space → 404, not its status').toBe(404)
    expect(await readImportStatus({ id: importId, tenantId: TENANT, spaceId: OTHER_SPACE }), 'and the reader agrees').toBeNull()
    // Cross-TENANT reads are refused by the same predicate.
    expect(await readImportStatus({ id: importId, tenantId: 'tenant_dev', spaceId: SPACE }), 'another tenant sees nothing').toBeNull()

    // A stranger with no edit on the space cannot read the progress of an import into it.
    await writeTuples(fgaClient, [{ user: `user:${STRANGER}`, relation: 'member', object: `tenant:${TENANT}` }])
    try {
      const { assertCanQueueImport } = await import('../import/jobs.js')
      await expect(assertCanQueueImport(fgaClient, STRANGER, SPACE), 'a non-editor is refused the status surface too')
        .rejects.toMatchObject({ statusCode: 403 })
    } finally {
      await deleteTuples(fgaClient, [{ user: `user:${STRANGER}`, relation: 'member', object: `tenant:${TENANT}` }]).catch(() => {})
    }
    await drain()
  }, 600_000)

  it('records a failure in the row instead of losing it, and does not leave the space locked', async () => {
    const res = await post(SPACE, vaultOf(IMPORT_SYNC_MAX_NODES + 1, 'doomed'))
    expect(res.statusCode).toBe(202)
    const { importId } = res.json()
    // The staged archive disappears (the failure a job path can actually have: storage lost the
    // object). The point is not the cause — it is that the job says so rather than staying "running".
    await admin`UPDATE imports SET archive_key = NULL WHERE id = ${importId}`

    expect(await drain()).toBe(1)
    const row = await readImportStatus({ id: importId, tenantId: TENANT, spaceId: SPACE })
    expect(row?.status, 'a failed job is failed, not forever-running').toBe('failed')
    expect(row?.error, 'and it says what went wrong').toBeTruthy()

    const next = await post(SPACE, vaultOf(IMPORT_SYNC_MAX_NODES + 1, 'after-failure'))
    expect(next.statusCode, 'a failed import releases the space slot').toBe(202)
    await drain()
  }, 600_000)
})

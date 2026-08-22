// Integration — real OpenFGA + real Postgres. #896 / ADR-255 Decision 5.
//
// ⚠️ WHY A LIVE FILE. The thing under test is what survives a FAILURE, and the failure is a store
// call that does not land. A stub store can be told to throw, but it cannot tell you whether the
// tuple is still there afterwards — and "the tuple is still there, and something still knows where"
// is the whole claim. So the store is real, and the one thing forced is the transport error.
//
// ⚠️ Own tenant, and every tuple written here is deleted in afterAll: a sibling test scans the WHOLE
// store looking for orphans, and residue left behind would surface there as a mystery.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { OpenFgaClient } from '@openfga/sdk'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples, groupFgaId } from '@wikistead/authz'
import { enqueueTupleDeletes, flushTupleDeletes, drainTupleOutbox, tupleOutboxBacklog } from '../db/tuple-outbox.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const T = `tob896_${STAMP}`
const SUB = `tob896-member-${STAMP}`
const GROUP = `tob896-group-${STAMP}`
const groupObject = () => `group:${groupFgaId(T, GROUP)}`
const intent = () => ({ subject: `user:${SUB}`, relation: 'member', object: groupObject() })

// A store whose delete always fails with a TRANSPORT error — not a validation refusal, so
// `alreadyConverged` is false and the handler must NOT treat it as done. This is the outage #378
// refuses to be blocked by, and the reason this queue exists.
const brokenStore = () =>
  new OpenFgaClient({ apiUrl: 'http://127.0.0.1:9', storeId: process.env.OPENFGA_STORE_ID! })

const rowsFor = (sub: string) =>
  pool<{ id: string }[]>`SELECT id FROM fga_tuple_outbox WHERE tenant_id = ${T} AND subject = ${`user:${sub}`}`
const tupleExists = async () => {
  const res = await fgaClient.read({ user: `user:${SUB}`, relation: 'member', object: groupObject() })
  return (res.tuples ?? []).length > 0
}

beforeAll(async () => {
  await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${T}, ${T}, 'business', 'logical') ON CONFLICT (id) DO NOTHING`
})

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: `user:${SUB}`, relation: 'member', object: groupObject() }]).catch(() => {})
  await pool`DELETE FROM fga_tuple_outbox WHERE tenant_id = ${T}`
  await admin`DELETE FROM tenants WHERE id = ${T}`
  await admin.end()
})

describe('#896 the tuple a removal could not delete is written down', () => {
  it('a store failure leaves the tuple AND a row that names it', async () => {
    await writeTuples(fgaClient, [{ user: `user:${SUB}`, relation: 'member', object: groupObject() }])
    // The removal's transaction: the queue row commits with the rows it belongs to.
    await pool.begin(async (tx) => { await enqueueTupleDeletes(tx as never, T, [intent()]) })
    // …then the store call, after commit, against a store that is down.
    await flushTupleDeletes(brokenStore(), T, [intent()])

    expect(await tupleExists(), 'the store is down, so the tuple is still there').toBe(true)
    const rows = await rowsFor(SUB)
    // ⚠️ THE assertion of this ticket: without the row, this tuple is now unfindable — its object
    // survives (other members keep the group alive) and the member row it came from is gone.
    expect(rows.length, 'and the queue still knows where it is').toBe(1)
  })

  it('the drain lands it once the store is back, and the row goes with it', async () => {
    expect((await rowsFor(SUB)).length, 'the previous case left it waiting').toBe(1)
    const drained = await drainTupleOutbox(fgaClient)
    expect(drained, 'one row left the queue').toBeGreaterThanOrEqual(1)
    expect(await tupleExists(), 'the tuple is gone from the store').toBe(false)
    expect((await rowsFor(SUB)).length, 'and the row that tracked it is gone').toBe(0)
  })

  it('a tuple somebody else already deleted drains as SUCCESS, by the flag', async () => {
    // At-least-once delivery redelivers, and the sweep may have got there first. Read the store's
    // sentence instead of the flag and every successful delete becomes a row that retries forever —
    // the queue depth would stop meaning "the drain is failing", which is the number the ruling
    // publishes for a person to read.
    const gone = { subject: `user:${SUB}-never-written`, relation: 'member', object: groupObject() }
    await pool.begin(async (tx) => { await enqueueTupleDeletes(tx as never, T, [gone]) })
    const drained = await drainTupleOutbox(fgaClient)
    expect(drained, 'the converged delete counts as done').toBeGreaterThanOrEqual(1)
    expect((await rowsFor(`${SUB}-never-written`)).length, 'so its row does not come back forever').toBe(0)
  })

  it('a row the store keeps refusing is NOT discarded, and the backlog says how old it is', async () => {
    // Ruled 2026-08-21. A queue that drops what it cannot deliver reports success while the residue
    // it exists to remove accumulates.
    const stuck = { subject: `user:${SUB}-stuck`, relation: 'member', object: groupObject() }
    await pool.begin(async (tx) => { await enqueueTupleDeletes(tx as never, T, [stuck]) })
    await pool`UPDATE fga_tuple_outbox SET created_at = now() - interval '3 hours'
                WHERE tenant_id = ${T} AND subject = ${stuck.subject}`
    await drainTupleOutbox(brokenStore())
    expect((await rowsFor(`${SUB}-stuck`)).length, 'the row waits rather than being thrown away').toBe(1)

    const backlog = await tupleOutboxBacklog()
    expect(backlog.waiting, 'the count a person reads').toBeGreaterThanOrEqual(1)
    expect(backlog.oldestAgeSeconds, 'and the age of the oldest — an old row is a signal').toBeGreaterThan(3 * 3600 - 60)
    await pool`DELETE FROM fga_tuple_outbox WHERE tenant_id = ${T} AND subject = ${stuck.subject}`
  })

  it('one refused tuple does not take its siblings down with it — measured in the STORE', async () => {
    // Per-tuple, because a batch delete is all-or-nothing. ⚠️ Asserting only that the ROWS are gone
    // cannot see the batched failure: one converged tuple makes the whole call fail with the
    // converged flag set, the handler reads it as success, and every row is dropped while the tuples
    // that were REAL are still in the store. That is worse than not draining — residue with no
    // record left, which is the condition this whole ADR opens with. So the store is asked.
    const a = { subject: `user:${SUB}-a`, relation: 'member', object: groupObject() }
    const b = { subject: `user:${SUB}-b`, relation: 'member', object: groupObject() }
    await writeTuples(fgaClient, [{ user: b.subject, relation: b.relation, object: b.object }])
    await pool.begin(async (tx) => { await enqueueTupleDeletes(tx as never, T, [a, b]) })
    await drainTupleOutbox(fgaClient)
    const live = await fgaClient.read({ user: b.subject, relation: b.relation, object: b.object })
    expect((live.tuples ?? []).length, 'the real tuple is GONE from the store').toBe(0)
    expect((await rowsFor(`${SUB}-a`)).length, 'the converged one is done').toBe(0)
    expect((await rowsFor(`${SUB}-b`)).length, 'and its row went with it').toBe(0)
  })

  it('the enqueue rolls back with the transaction it belongs to', async () => {
    // Enqueue-then-delete only holds if the row shares the removal's fate. A row written on a
    // session handle would outlive a rolled-back removal and ask the drain to delete a tuple whose
    // member is still seated — the failure direction is an authz LOSS, not residue.
    const doomed = { subject: `user:${SUB}-rolledback`, relation: 'member', object: groupObject() }
    await pool.begin(async (tx) => {
      await enqueueTupleDeletes(tx as never, T, [doomed])
      throw new Error('the removal failed after the enqueue')
    }).catch(() => {})
    expect((await rowsFor(`${SUB}-rolledback`)).length, 'no row survives a removal that did not happen').toBe(0)
  })
})

// #968 (review, #947 round F3): linkMemberIdentity's SELECT-then-INSERT has a real race — two
// concurrent calls for the SAME (tenant, connection, external subject) can both see "no row" before
// either INSERTs, so the loser hits the UNIQUE constraint as a raw postgres 23505 instead of the
// identity_taken this function otherwise throws. routes/auth.ts's catch only recognizes
// code === 'identity_taken', so the loser's raw postgres error reached app.ts's setErrorHandler as an
// undocumented JSON 500 — the route's own docs (docs/api-reference.md) say it never answers with JSON.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { linkMemberIdentity } from '../auth/member-identities.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const SUB_X = `race968-x-${STAMP}`
const SUB_Y = `race968-y-${STAMP}`

let db: TenantDb

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  for (const sub of [SUB_X, SUB_Y]) {
    await admin`INSERT INTO members (tenant_id, sub, email, display_name, role)
      VALUES (${TENANT}, ${sub}, ${`${sub}@x.test`}, 'Race Member', 'member')
      ON CONFLICT (tenant_id, sub) DO NOTHING`
  }
}, 30_000)

afterAll(async () => {
  await admin`DELETE FROM members WHERE sub IN (${SUB_X}, ${SUB_Y})`.catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
}, 30_000)

describe('#968: linkMemberIdentity survives its own SELECT-then-INSERT race', () => {
  it('the same member racing itself: both calls resolve, one row, no raw postgres error', async () => {
    const connectionId = `race968-conn-same-${STAMP}`
    const externalSubject = `race968-ext-same-${STAMP}`
    const results = await Promise.allSettled([
      linkMemberIdentity(db, TENANT, connectionId, externalSubject, SUB_X),
      linkMemberIdentity(db, TENANT, connectionId, externalSubject, SUB_X),
    ])
    for (const r of results) {
      expect(r.status, `neither call may reject: ${JSON.stringify(r)}`).toBe('fulfilled')
    }
    const rows = await admin<{ member_sub: string }[]>`
      SELECT member_sub FROM member_identities WHERE tenant_id = ${TENANT} AND connection_id = ${connectionId} AND external_subject = ${externalSubject}`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.member_sub).toBe(SUB_X)
  })

  it('two DIFFERENT members racing for the same identity: the loser gets 409 identity_taken, never a raw postgres error', async () => {
    const connectionId = `race968-conn-diff-${STAMP}`
    const externalSubject = `race968-ext-diff-${STAMP}`
    const results = await Promise.allSettled([
      linkMemberIdentity(db, TENANT, connectionId, externalSubject, SUB_X),
      linkMemberIdentity(db, TENANT, connectionId, externalSubject, SUB_Y),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(fulfilled, 'exactly one of the two racers wins').toHaveLength(1)
    expect(rejected, 'exactly one of the two racers loses').toHaveLength(1)
    expect(rejected[0]!.reason, 'the loser is the documented 409, never a raw postgres error').toMatchObject({
      statusCode: 409,
      code: 'identity_taken',
    })
    const rows = await admin<{ member_sub: string }[]>`
      SELECT member_sub FROM member_identities WHERE tenant_id = ${TENANT} AND connection_id = ${connectionId} AND external_subject = ${externalSubject}`
    expect(rows, 'exactly one row holds the identity, not two').toHaveLength(1)
  })
})

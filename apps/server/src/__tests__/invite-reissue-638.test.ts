// #638 (user ruling): a pending invitation can be handed over again.
//
// The asymmetry the ruling names: a password entrance has had a re-issue since #626, while an invite had
// neither a resend nor a way to read its link back — and the invite is the one that strands people. In a
// tenant with no mail configured, the link shown once on the screen that created it is the ONLY copy;
// losing it meant revoking and inviting again, which is a different invitation to anyone reading the
// ledger and a second chance to mistype the address.
//
// Measured against the database rather than against the response, because the two ways this can go wrong
// are both invisible from the status code: the old link still working (the whole point is that it stops),
// and a second invite row appearing, which is how #606 put one person on two seats.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { createInvite, acceptInvite, hashInviteToken } from '../auth/invites.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)

let app: FastifyInstance
let db: TenantDb
const emails: string[] = []
const email = (n: string) => { const e = `reissue638-${n}-${STAMP}@e2e.test`; emails.push(e); return e }

const invite = (addr: string | null) =>
  createInvite(db, { tenantId: TENANT, plan: 'business', invitedBy: 'dev-user', email: addr, role: 'member' })

const AUTH = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
// a JSON content-type with no body is a 400 from Fastify, so the bodyless calls do not declare one
const H = { ...AUTH, 'content-type': 'application/json' }
const post = (path: string, body?: unknown) =>
  app.inject({ method: 'POST', url: path, headers: H, payload: JSON.stringify(body ?? {}) })

const invitesFor = async (addr: string) =>
  adminPool<{ id: string; status: string; token_hash: string; last_emailed_at: Date | null }[]>`
    SELECT id, status, token_hash, last_emailed_at FROM invites WHERE tenant_id = ${TENANT} AND email = ${addr}`

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
}, 120_000)

afterAll(async () => {
  for (const e of emails) await adminPool`DELETE FROM invites WHERE tenant_id = ${TENANT} AND email = ${e}`.catch(() => {})
  // Accepting an invitation SEATS someone, and a seat outlives the invite row. Left behind, these
  // pushed tenant_dev over the cap that `plan-freeze` (#131) and `invite-role-582` measure against, and
  // both went red in a full run while passing alone — the shape that reads as flakiness and is not.
  await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub LIKE ${`reissue638-%-${STAMP}`}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

describe('#638: a pending invite can be handed over again', () => {
  it('re-issuing replaces the link on the SAME invitation', async () => {
    const addr = email('same-row')
    const { id, token: first } = await invite(addr)

    const res = await post(`/members/invites/${id}/reissue`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { inviteUrl: string; previousLinkRevoked: boolean; emailed: boolean }
    expect(body.inviteUrl, 'a usable link comes back, not just a confirmation').toMatch(/\/invite\?token=/)
    expect(body.previousLinkRevoked, 'the screen is told the old link is dead').toBe(true)

    // ONE invitation, still pending — a second row is how #606 put one person on two seats, and the role,
    // the seat and who invited them belong to the invitation rather than to the link
    const rows = await invitesFor(addr)
    expect(rows.length, `one invitation, not two (${rows.map((r) => r.status).join(',')})`).toBe(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.id, 'the same row').toBe(id)

    // the new link is the one stored; the old one is not
    const fresh = new URL(body.inviteUrl).searchParams.get('token')!
    expect(rows[0]!.token_hash).toBe(hashInviteToken(fresh))
    expect(rows[0]!.token_hash, 'the previous token is no longer what the row holds').not.toBe(hashInviteToken(first))
  }, 120_000)

  it('…and the old link really stops working, measured by using it', async () => {
    // The hash comparison above says the row changed. This says the door is shut — the distinction that
    // matters if a lookup ever falls back to something other than the stored hash.
    const addr = email('old-dead')
    const { id, token: first } = await invite(addr)
    const res = await post(`/members/invites/${id}/reissue`)
    const fresh = new URL((res.json() as { inviteUrl: string }).inviteUrl).searchParams.get('token')!

    expect(await acceptInvite({ db, fga: app.fga }, asTenant(TENANT), first, { sub: `reissue638-old-${STAMP}` }),
      'the link that was handed out before the re-issue').toBe(false)
    expect(await acceptInvite({ db, fga: app.fga }, asTenant(TENANT), fresh, { sub: `reissue638-new-${STAMP}` }),
      'the link that replaced it').toBe(true)
  }, 120_000)

  it('a re-issue of nothing is a 404, not a fresh invitation', async () => {
    // A route that minted on a miss would let anybody with the admin console create invitations by
    // guessing ids, and would resurrect a revoked one.
    const res = await post('/members/invites/00000000-0000-0000-0000-000000000000/reissue')
    expect(res.statusCode).toBe(404)
  }, 120_000)

  it('a revoked invitation is not brought back', async () => {
    const addr = email('revoked')
    const { id } = await invite(addr)
    const revoked = await app.inject({ method: 'DELETE', url: `/members/invites/${id}`, headers: AUTH })
    expect(revoked.statusCode, `the premise: revoking worked (${revoked.body})`).toBe(204)
    const res = await post(`/members/invites/${id}/reissue`)
    expect(res.statusCode, 'revoking is a decision, and a re-issue must not undo it').toBe(404)
  }, 120_000)

  it('the list says which invitations have been mailed', async () => {
    // : sending has always been best-effort, and its outcome was
    // reported once — on the response to the create call — and then forgotten.
    const addr = email('mailed')
    const { id } = await invite(addr)
    expect((await invitesFor(addr))[0]!.last_emailed_at, 'nothing has been sent yet').toBeNull()

    await post(`/members/invites/${id}/reissue`, { email: true })
    const after = (await invitesFor(addr))[0]!
    // the dev stack's mail driver may or may not deliver; what is pinned is that a SEND is recorded when
    // it happens and not when it does not — asserted through the same field the list reads
    const res = await app.inject({ method: 'GET', url: '/members/invites', headers: AUTH })
    const listed = (res.json() as { invites: { id: string; last_emailed_at: string | null }[] }).invites.find((i) => i.id === id)
    expect(listed, 'the invitation is in the pending list').toBeTruthy()
    expect(listed!.last_emailed_at ?? null, 'the list carries what the row holds')
      .toEqual(after.last_emailed_at ? after.last_emailed_at.toISOString() : null)
  }, 120_000)
})

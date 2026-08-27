// #858 / #929, ADR-264 §5: the re-key ADR-259 §3.5 named and #960 excluded ("re-key EXCLUDED").
// §1.3's uniform "this link no longer works" for a stranded invite is #948's existing behaviour
// (invites.ts:281 catches `address_taken` and returns false) and is untouched here — this file adds
// no assertion for it, since nothing in this ticket's diff can change it (invites.ts is not touched).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import type { Tenant } from '@wikistead/types'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'
import { subjectPrefixFor, MAX_OIDC_CONNECTIONS } from '../routes/admin-connections.js'
import { applyConnectionSupersession, supersessionMismatch } from '../auth/connection-rekey.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)

let app: FastifyInstance
let tenant: PrivateTenant
let db: TenantDb

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = await privateTenant(admin, `t929-${STAMP}`)
  db = await acquireTenantDb({ id: tenant.id, slug: tenant.slug, plan: 'business', isolation: 'logical' } as Tenant)
}, 60_000)

afterAll(async () => {
  await db?.release()
  await tenant?.dispose()
  await app.close(); await admin.end(); await pool.end()
}, 60_000)

const makeConnection = async (opts: { issuer?: string; clientId?: string } = {}): Promise<{ id: string; prefix: string }> => {
  const id = randomUUID()
  const prefix = subjectPrefixFor(id)
  await admin`INSERT INTO tenant_oidc (id, tenant_id, issuer, client_id, redirect_uri, enabled, subject_prefix)
              VALUES (${id}, ${tenant.id}, ${opts.issuer ?? 'https://idp.t929.test'}, ${opts.clientId ?? ''},
                      'https://t929.test/auth/callback', TRUE, ${prefix})`
  return { id, prefix }
}
const linkRows = async (connId: string) =>
  admin<{ external_subject: string; member_sub: string }[]>`
    SELECT external_subject, member_sub FROM member_identities WHERE connection_id = ${connId}`
const cleanupConn = async (...ids: string[]) => {
  for (const id of ids) {
    await admin`DELETE FROM member_identities WHERE connection_id = ${id}`.catch(() => {})
    await admin`DELETE FROM tenant_oidc WHERE id = ${id}`.catch(() => {})
  }
}
const cleanupMembers = async (...subs: string[]) => {
  await admin`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub = ANY(${subs})`.catch(() => {})
}

describe('#929 / ADR-264 §3.1-§3.2: the constraint on which pairs may be declared', () => {
  it('refuses a re-key across different issuers, and writes nothing', async () => {
    const oldConn = await makeConnection({ issuer: 'https://idp-a.t929.test' })
    const newConn = await makeConnection({ issuer: 'https://idp-b.t929.test' })
    const sub = `${oldConn.prefix}x1`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${sub}, ${`${sub}@t929.test`}, 'member')`
    try {
      await expect(applyConnectionSupersession(db, { id: tenant.id, plan: 'business' }, 'dev-user', newConn.id, oldConn.id))
        .rejects.toMatchObject({ statusCode: 409, code: 'issuer_mismatch' })
      expect(await linkRows(newConn.id)).toHaveLength(0)
    } finally {
      await cleanupMembers(sub)
      await cleanupConn(oldConn.id, newConn.id)
    }
  }, 30_000)

  it('same issuer alone is not sufficient — refuses on a differing client_id, independently of the issuer check', async () => {
    const oldConn = await makeConnection({ issuer: 'https://idp-c.t929.test', clientId: 'client-old' })
    const newConn = await makeConnection({ issuer: 'https://idp-c.t929.test', clientId: 'client-new' })
    expect(supersessionMismatch(
      { id: newConn.id, issuer: 'https://idp-c.t929.test', client_id: 'client-new', subject_prefix: newConn.prefix },
      { id: oldConn.id, issuer: 'https://idp-c.t929.test', client_id: 'client-old', subject_prefix: oldConn.prefix },
    ), 'issuer matches, but the predicate still refuses on client_id alone').toBe('client_id_mismatch')
    const sub = `${oldConn.prefix}x2`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${sub}, ${`${sub}@t929.test`}, 'member')`
    try {
      await expect(applyConnectionSupersession(db, { id: tenant.id, plan: 'business' }, 'dev-user', newConn.id, oldConn.id))
        .rejects.toMatchObject({ statusCode: 409, code: 'client_id_mismatch' })
      expect(await linkRows(newConn.id)).toHaveLength(0)
    } finally {
      await cleanupMembers(sub)
      await cleanupConn(oldConn.id, newConn.id)
    }
  }, 30_000)
})

describe('#929 / ADR-264 §3.3: checked at declaration, re-checked at apply', () => {
  it('a mutation in the gap between declare and apply flips the outcome — the apply refuses', async () => {
    const oldConn = await makeConnection({ issuer: 'https://idp-d.t929.test' })
    const newConn = await makeConnection({ issuer: 'https://idp-d.t929.test' }) // matches at declare time
    const sub = `${oldConn.prefix}x3`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${sub}, ${`${sub}@t929.test`}, 'member')`
    try {
      await expect(applyConnectionSupersession(db, { id: tenant.id, plan: 'business' }, 'dev-user', newConn.id, oldConn.id, {
        beforeApply: async () => {
          // Someone edits the OLD connection's issuer between the two checks — a live row, changeable.
          await admin`UPDATE tenant_oidc SET issuer = 'https://idp-d-edited.t929.test' WHERE id = ${oldConn.id}`
        },
      })).rejects.toMatchObject({ statusCode: 409, code: 'issuer_mismatch' })
      expect(await linkRows(newConn.id), 'the apply-time re-check caught the edit — nothing written').toHaveLength(0)
    } finally {
      await cleanupMembers(sub)
      await cleanupConn(oldConn.id, newConn.id)
    }
  }, 30_000)
})

describe('#929 / ADR-264 §3.4: the connection cap names re-key as the reason', () => {
  it('a tenant holding 20 connections is refused at creation, and the message names re-key; 19 is not refused', async () => {
    const made: string[] = []
    try {
      for (let i = 0; i < MAX_OIDC_CONNECTIONS - 1; i++) made.push((await makeConnection()).id)
      // 19 held: creating one more (the 20th) must succeed.
      const ok = await app.inject({
        method: 'POST', url: '/admin/connections', headers: tenant.H,
        payload: { issuer: 'https://idp-cap.t929.test', clientId: 'cap-19', label: 'cap-19', enabled: false },
      })
      expect(ok.statusCode, ok.body).toBe(201)
      made.push((ok.json() as { id: string }).id)

      // 20 held: the 21st is refused, naming re-key.
      const refused = await app.inject({
        method: 'POST', url: '/admin/connections', headers: tenant.H,
        payload: { issuer: 'https://idp-cap.t929.test', clientId: 'cap-20', label: 'cap-20', enabled: false },
      })
      expect(refused.statusCode, refused.body).toBe(409)
      const body = refused.json() as { code: string; message: string }
      expect(body.code).toBe('connection_limit_reached')
      expect(body.message.toLowerCase(), 'the refusal names re-key, not just the cap').toContain('re-key')
    } finally {
      await cleanupConn(...made)
    }
  }, 30_000)
})

describe('#929 / ADR-264 §2: narrow by construction — only subs carrying the retiring prefix', () => {
  it('a re-key links only the old connection\'s minted subs, leaving an unrelated raw (SCIM/legacy-shaped) sub untouched', async () => {
    const oldConn = await makeConnection({ issuer: 'https://idp-e.t929.test' })
    const newConn = await makeConnection({ issuer: 'https://idp-e.t929.test' })
    const carrierSub = `${oldConn.prefix}x4`
    const rawSub = `t929-scim-raw-${STAMP}` // no wc<conn8>_ prefix at all — the SCIM/pre-094-legacy shape
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${carrierSub}, ${`${carrierSub}@t929.test`}, 'member')`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${rawSub}, ${`${rawSub}@t929.test`}, 'member')`
    try {
      const result = await applyConnectionSupersession(db, { id: tenant.id, plan: 'business' }, 'dev-user', newConn.id, oldConn.id)
      expect(result.linksWritten).toBe(1)
      const rows = await linkRows(newConn.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.member_sub).toBe(carrierSub)

      // Break-check: widening the selection to ALL of the tenant's members (dropping the LIKE
      // oldPrefix filter this module applies) would additionally reach the raw sub — proving the
      // narrowness is doing real work, not passing vacuously because no such sub existed.
      const widened = await admin<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${tenant.id} AND sub = ANY(${[carrierSub, rawSub]})`
      expect(widened.map((r) => r.sub).sort(), 'the widened query would have reached the raw sub too').toEqual([carrierSub, rawSub].sort())
    } finally {
      await cleanupMembers(carrierSub, rawSub)
      await cleanupConn(oldConn.id, newConn.id)
    }
  }, 30_000)
})

describe('#929 / ADR-264 §3.5 + §5: the collision, only reachable through an emailless member', () => {
  it('refuses and writes NOTHING when the new connection already seated a different, emailless member at the target subject', async () => {
    const oldConn = await makeConnection({ issuer: 'https://idp-f.t929.test' })
    const newConn = await makeConnection({ issuer: 'https://idp-f.t929.test' })
    const clashingX = 'x-clash'
    const harmlessCarrier = `${oldConn.prefix}x-harmless`
    const oldSub = `${oldConn.prefix}${clashingX}`
    const alreadySeated = `${newConn.prefix}${clashingX}` // §2's collision case: new connection minted this already
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${oldSub}, NULL, 'member')` // emailless — required, see below
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${alreadySeated}, NULL, 'member')`
    await admin`INSERT INTO members (tenant_id, sub, email, role) VALUES (${tenant.id}, ${harmlessCarrier}, ${`${harmlessCarrier}@t929.test`}, 'member')`
    try {
      await expect(applyConnectionSupersession(db, { id: tenant.id, plan: 'business' }, 'dev-user', newConn.id, oldConn.id))
        .rejects.toMatchObject({
          statusCode: 409, code: 'supersession_collision',
          collisions: [{ oldSub, otherSub: alreadySeated }],
        })
      // Nothing written — not even the harmless, non-colliding carrier (whole-set check, not partial).
      expect(await linkRows(newConn.id), 'a collision on one carrier writes nothing for ANY carrier').toHaveLength(0)
    } finally {
      await cleanupMembers(oldSub, alreadySeated, harmlessCarrier)
      await cleanupConn(oldConn.id, newConn.id)
    }
  }, 30_000)
})

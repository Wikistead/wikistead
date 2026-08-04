// Integration tests — real Postgres + real OpenFGA + real Valkey, no mocks.
// Drives the member-management API via app.inject with cookie sessions. Focus:
// the admin authz matrix (point 7), the last-admin lockout guard, and immediate
// session revocation on removal (point 7 — the §7 session index).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { groupFgaId } from '../auth/group-sync.js'
import { buildApp } from '../app.js'
import { provisionTenant } from '../auth/provisioning.js'
import { createSession, SESSION_COOKIE } from '../auth/session.js'
import { drainAuditFor } from './helpers/audit-drain.js'
import { acquireTenantDb } from '../db/tenant-db.js' // #474: fixture keys for the removal sweep
import { createApiKey } from '../routes/api-keys.js'
import { verifyApiKey } from '../api-key-auth.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')

const hasRel = async (user: string, relation: string, object: string) =>
  Boolean((await fgaClient.check({ user, relation, object })).allowed)

let app: FastifyInstance
let tenantId: string
let slug: string
let host: string
let adminSid: string
let plainSid: string

const cookie = (sid: string) => `${SESSION_COOKIE}=${sid}`

// Insert a member row + its FGA grants directly (test fixture).
async function seedMember(sub: string, role: 'admin' | 'member') {
  await admin`SELECT set_config('app.tenant_id', ${tenantId}, false)`
  await admin`INSERT INTO members (tenant_id, sub, role) VALUES (${tenantId}, ${sub}, ${role})
              ON CONFLICT (tenant_id, sub) DO UPDATE SET role = EXCLUDED.role`
  const tuples = [{ user: `user:${sub}`, relation: 'member', object: `tenant:${tenantId}` }]
  if (role === 'admin') tuples.push({ user: `user:${sub}`, relation: 'admin', object: `tenant:${tenantId}` })
  await writeTuples(fgaClient, tuples)
}

beforeAll(async () => {
  slug = `p14mem-${Date.now().toString(36)}`
  host = `${slug}.localhost`
  ;({ tenantId } = await provisionTenant(fgaClient, { slug, admin: { sub: 'mem-admin', email: 'a@x.test' } }))
  await seedMember('mem-admin2', 'admin') // second admin so the guard has room
  await seedMember('mem-plain', 'member')

  app = await buildApp()
  await app.ready()
  adminSid = await createSession(valkey, { tenantId, sub: 'mem-admin', role: 'admin' })
  plainSid = await createSession(valkey, { tenantId, sub: 'mem-plain', role: 'member' })
}, 60_000)

afterAll(async () => {
  await app.close()
  for (const sub of ['mem-admin', 'mem-admin2', 'mem-plain', 'mem-victim', 'mem-audit', 'mem-keyed', 'mem-bystander']) {
    await deleteTuples(fgaClient, [
      { user: `user:${sub}`, relation: 'member', object: `tenant:${tenantId}` },
      { user: `user:${sub}`, relation: 'admin', object: `tenant:${tenantId}` },
    ]).catch(() => {})
  }
  await admin`DELETE FROM invites WHERE tenant_id = ${tenantId}`.catch(() => {})
  // member ops now enqueue audit intents (#177); clean them before the tenant FK delete.
  await admin`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM audit_outbox WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await admin.end()
  await valkey.quit()
  await pool.end()
}, 60_000)

// ── point 7: a non-admin member must not reach ANY management route ──────────
describe('admin authz matrix', () => {
  const reqs: [string, string][] = [
    ['GET', '/members'],
    ['GET', '/members/invites'],
    ['POST', '/members/invites'],
    ['PATCH', '/members/mem-admin2'],
    ['DELETE', '/members/mem-admin2'],
    ['DELETE', '/members/invites/some-id'],
  ]
  for (const [method, url] of reqs) {
    it(`rejects a non-admin: ${method} ${url} → 403`, async () => {
      const res = await app.inject({ method: method as 'GET', url, headers: { host, cookie: cookie(plainSid) }, payload: { role: 'member' } })
      expect(res.statusCode).toBe(403)
    })
  }

  it('allows an admin to list members', async () => {
    const res = await app.inject({ method: 'GET', url: '/members', headers: { host, cookie: cookie(adminSid) } })
    expect(res.statusCode).toBe(200)
    const subs = (res.json().members as { sub: string }[]).map((m) => m.sub).sort()
    expect(subs).toEqual(['mem-admin', 'mem-admin2', 'mem-plain'])
  })
})

// ── #3 avatar identity exposure: /auth/me is peer-visible identity → display name +
// picture ONLY, never email. The admin /members list (admin-only) may include email
// AND picture (for member-list avatars). This is a privacy boundary, so it gets a
// dedicated test (the project design notes: authz/privacy boundaries must be tested).
describe('avatar identity exposure (#3)', () => {
  beforeAll(async () => {
    await admin`SELECT set_config('app.tenant_id', ${tenantId}, false)`
    await admin`UPDATE members SET display_name = 'Ada Lovelace', picture_url = 'https://idp.test/ada.png', email = 'ada@x.test' WHERE tenant_id = ${tenantId} AND sub = 'mem-admin'`
  })

  it('/auth/me returns sub + displayName + picture, but NEVER email', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { host, cookie: cookie(adminSid) } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.sub).toBe('mem-admin')
    expect(body.displayName).toBe('Ada Lovelace')
    expect(body.picture).toBe('https://idp.test/ada.png')
    expect(body).not.toHaveProperty('email')
    expect(JSON.stringify(body)).not.toContain('ada@x.test')
  })

  it('the admin /members list carries picture_url for avatars', async () => {
    const res = await app.inject({ method: 'GET', url: '/members', headers: { host, cookie: cookie(adminSid) } })
    expect(res.statusCode).toBe(200)
    const me = (res.json().members as { sub: string; picture_url: string | null }[]).find((m) => m.sub === 'mem-admin')
    expect(me?.picture_url).toBe('https://idp.test/ada.png')
  })
})

// ── invites via the admin API ───────────────────────────────────────────────
describe('invite admin API', () => {
  it('creates an invite (returns the link), lists it, then revokes it', async () => {
    const create = await app.inject({
      method: 'POST', url: '/members/invites',
      headers: { host, cookie: cookie(adminSid) }, payload: { email: 'newbie@x.test', role: 'member' },
    })
    expect(create.statusCode).toBe(201)
    const body = create.json() as { inviteUrl: string; emailed: boolean }
    expect(body.inviteUrl).toMatch(/\/invite\?token=inv_/)
    expect(typeof body.emailed).toBe('boolean')

    const list = await app.inject({ method: 'GET', url: '/members/invites', headers: { host, cookie: cookie(adminSid) } })
    const invites = list.json().invites as { id: string; email: string }[]
    expect(invites.some((i) => i.email === 'newbie@x.test')).toBe(true)

    const id = invites.find((i) => i.email === 'newbie@x.test')!.id
    const del = await app.inject({ method: 'DELETE', url: `/members/invites/${id}`, headers: { host, cookie: cookie(adminSid) } })
    expect(del.statusCode).toBe(204)
    const after = await app.inject({ method: 'GET', url: '/members/invites', headers: { host, cookie: cookie(adminSid) } })
    expect((after.json().invites as unknown[]).length).toBe(0)
  })
})

// ── role changes + FGA tuple sync ───────────────────────────────────────────
describe('role change', () => {
  it('promotes a member to admin and demotes back, syncing the FGA admin tuple', async () => {
    const up = await app.inject({ method: 'PATCH', url: '/members/mem-plain', headers: { host, cookie: cookie(adminSid) }, payload: { role: 'admin' } })
    expect(up.statusCode).toBe(200)
    expect(await hasRel('user:mem-plain', 'admin', `tenant:${tenantId}`)).toBe(true)

    const down = await app.inject({ method: 'PATCH', url: '/members/mem-plain', headers: { host, cookie: cookie(adminSid) }, payload: { role: 'member' } })
    expect(down.statusCode).toBe(200)
    expect(await hasRel('user:mem-plain', 'admin', `tenant:${tenantId}`)).toBe(false)
    expect(await hasRel('user:mem-plain', 'member', `tenant:${tenantId}`)).toBe(true) // still a member
  })
})

// ── point 7: immediate session revocation on removal ────────────────────────
describe('removal revokes sessions immediately', () => {
  it("deletes a removed member's live session (not at TTL)", async () => {
    await seedMember('mem-victim', 'member')
    const victimSid = await createSession(valkey, { tenantId, sub: 'mem-victim', role: 'member' })
    // Sanity: the victim can use their session.
    const before = await app.inject({ method: 'GET', url: '/auth/me', headers: { host, cookie: cookie(victimSid) } })
    expect(before.statusCode).toBe(200)

    const del = await app.inject({ method: 'DELETE', url: '/members/mem-victim', headers: { host, cookie: cookie(adminSid) } })
    expect(del.statusCode).toBe(204)

    // The previously-valid session no longer authenticates.
    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { host, cookie: cookie(victimSid) } })
    expect(after.statusCode).toBe(401)
    expect(await hasRel('user:mem-victim', 'member', `tenant:${tenantId}`)).toBe(false)
  })

  // #378: removing a member must also drop their group-membership tuples. Left behind, they keep granting
  // group-inherited access (authz leak) AND break a later re-registration of the same sub (syncMemberGroups
  // re-writes an existing tuple → FGA duplicate error → login tx rollback → permanent login failure).
  it('#378: removal deletes the member group#member tuples (no leak; re-registration re-writes cleanly)', async () => {
    const sub = 'mem-grp'
    const groups = ['Engineering', 'Ops']
    const gTuple = (g: string) => ({ user: `user:${sub}`, relation: 'member', object: `group:${groupFgaId(tenantId, g)}` })
    await admin`SELECT set_config('app.tenant_id', ${tenantId}, false)`
    await admin`INSERT INTO members (tenant_id, sub, role, groups) VALUES (${tenantId}, ${sub}, 'member', ${groups})
                ON CONFLICT (tenant_id, sub) DO UPDATE SET role='member', groups=EXCLUDED.groups`
    await writeTuples(fgaClient, [{ user: `user:${sub}`, relation: 'member', object: `tenant:${tenantId}` }, ...groups.map(gTuple)])
    expect(await hasRel(`user:${sub}`, 'member', `group:${groupFgaId(tenantId, 'Engineering')}`)).toBe(true) // sanity

    const del = await app.inject({ method: 'DELETE', url: `/members/${sub}`, headers: { host, cookie: cookie(adminSid) } })
    expect(del.statusCode).toBe(204)

    // the group-membership tuples are GONE — no group-inherited capability survives the removal.
    for (const g of groups) expect(await hasRel(`user:${sub}`, 'member', `group:${groupFgaId(tenantId, g)}`)).toBe(false)
    expect(await hasRel(`user:${sub}`, 'member', `tenant:${tenantId}`)).toBe(false)

    // re-registration: re-writing the SAME group tuples now succeeds (the stale ones were cleared, so no
    // FGA duplicate-write error that would roll the login tx back — the permanent-login-failure path is fixed).
    await expect(writeTuples(fgaClient, groups.map(gTuple))).resolves.toBeUndefined()
    await deleteTuples(fgaClient, groups.map(gTuple)).catch(() => {}) // cleanup
  })

  // #396 (#378 follow-up): removal must also sweep the member's DIRECT space/page grants — left behind,
  // they wake up if the same sub ever re-enrolls (the residual authz leak). Bounds pinned here: the sweep
  // is TENANT-SCOPED (the shared FGA store spans tenants — a same-sub grant on another tenant's resource
  // survives) and `restricted` DENIES are kept (a re-enrolled sub stays restricted where it was).
  it('#396: removal sweeps direct space/page grants — this tenant only, denies kept', async () => {
    const sub = 'mem-direct'
    await seedMember(sub, 'member')
    await admin`SELECT set_config('app.tenant_id', ${tenantId}, false)`
    // fresh rows every run: provisionTenant mints a NEW tenant id per run, so an ON CONFLICT DO NOTHING
    // leftover from an aborted earlier run would keep the OLD tenant_id and hide the rows from this run's
    // RLS-scoped sweep (exactly the bug this test would then falsely report).
    await admin`DELETE FROM pages WHERE id = 'm396-page'`
    await admin`DELETE FROM spaces WHERE id = 'm396-space'`
    await admin`INSERT INTO spaces (id, tenant_id, name) VALUES ('m396-space', ${tenantId}, 'm396')`
    await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at)
                VALUES ('m396-page', ${tenantId}, 'm396-space', 'p', 'body', now())`
    const grants = [
      { user: `user:${sub}`, relation: 'editor_member', object: 'space:m396-space' },
      { user: `user:${sub}`, relation: 'view_direct', object: 'page:m396-page' },
      { user: `user:${sub}`, relation: 'moderate', object: 'page:m396-page' }, // #330's new grant class sweeps too
    ]
    const restrictedDeny = { user: `user:${sub}`, relation: 'restricted', object: 'page:m396-page' }
    // The shared-store hazard: the SAME sub granted on a resource this tenant does NOT own (no DB row
    // under this tenant's RLS) — the sweep must not touch it.
    const foreignGrant = { user: `user:${sub}`, relation: 'view_direct', object: 'page:m396-foreign' }
    // idempotent re-run hygiene: a prior aborted run may have left any of these tuples behind.
    for (const t of [...grants, restrictedDeny, foreignGrant]) await deleteTuples(fgaClient, [t]).catch(() => {})
    await writeTuples(fgaClient, [...grants, restrictedDeny, foreignGrant])

    const del = await app.inject({ method: 'DELETE', url: `/members/${sub}`, headers: { host, cookie: cookie(adminSid) } })
    expect(del.statusCode).toBe(204)

    for (const g of grants) expect(await hasRel(g.user, g.relation, g.object)).toBe(false) // grants swept
    expect(await hasRel(restrictedDeny.user, 'restricted', restrictedDeny.object)).toBe(true) // deny kept
    expect(await hasRel(foreignGrant.user, 'view_direct', foreignGrant.object)).toBe(true) // other tenant untouched

    await deleteTuples(fgaClient, [restrictedDeny, foreignGrant]).catch(() => {}) // cleanup
    await admin`DELETE FROM pages WHERE id = 'm396-page'`.catch(() => {})
    await admin`DELETE FROM spaces WHERE id = 'm396-space'`.catch(() => {})
  })
})

// ── last-admin lockout guard (run last: it demotes the spare admin) ──────────
describe('last-admin guard', () => {
  it('refuses to demote or remove the final admin', async () => {
    // Demote the spare admin → mem-admin is now the ONLY admin.
    const demoteSpare = await app.inject({ method: 'PATCH', url: '/members/mem-admin2', headers: { host, cookie: cookie(adminSid) }, payload: { role: 'member' } })
    expect(demoteSpare.statusCode).toBe(200)

    const demoteLast = await app.inject({ method: 'PATCH', url: '/members/mem-admin', headers: { host, cookie: cookie(adminSid) }, payload: { role: 'member' } })
    expect(demoteLast.statusCode).toBe(409)

    const removeLast = await app.inject({ method: 'DELETE', url: '/members/mem-admin', headers: { host, cookie: cookie(adminSid) } })
    expect(removeLast.statusCode).toBe(409)
    // Still an admin (guard held).
    expect(await hasRel('user:mem-admin', 'admin', `tenant:${tenantId}`)).toBe(true)
  })
})

// ── #177: admin member ops write a durable, EE-gated audit entry ─────────────
// LAST describe: it seeds + promotes mem-audit, so it must not precede the count /
// last-admin assertions above.
describe('member ops → audit log (#177)', () => {
  it('a role change records a member.role_changed audit entry (entitled tenant)', async () => {
    await seedMember('mem-audit', 'member') // provisionTenant has no cloud resolver → UNLIMITED.auditLog
    const res = await app.inject({ method: 'PATCH', url: '/members/mem-audit', headers: { host, cookie: cookie(adminSid), 'content-type': 'application/json' }, payload: JSON.stringify({ role: 'admin' }) })
    expect(res.statusCode).toBe(200)
    await drainAuditFor(admin, tenantId)
    const rows = await admin<{ actor: string; action: string; target: string }[]>`
      SELECT actor, action, target FROM audit_log WHERE tenant_id = ${tenantId} ORDER BY seq`
    expect(rows.some((r) => r.action === 'member.role_changed' && r.target === 'user:mem-audit' && r.actor === 'user:mem-admin')).toBe(true)
  })

  // #474: removal already strips sessions, membership/group tuples and direct grants — the member's API
  // keys were the one credential left behind, and an API key outlives a session. Pinned end to end: the
  // key authenticates while the member exists, and stops the moment they are removed.
  it('#474: removal revokes the member\'s API keys — and nobody else\'s', async () => {
    await seedMember('mem-keyed', 'member')
    await seedMember('mem-bystander', 'member')
    // acquireTenantDb RESERVES a pooled connection — release it, or afterAll's pool.end() waits on it
    // and the hook times out (60s) long after every assertion has passed.
    const db = await acquireTenantDb({ id: tenantId, slug, plan: 'free', isolation: 'logical' } as never)
    let victim: Awaited<ReturnType<typeof createApiKey>>
    let bystander: Awaited<ReturnType<typeof createApiKey>>
    try {
      victim = await createApiKey(db, { tenantId, plan: 'free', ownerUserId: 'mem-keyed', name: 'victim key' })
      bystander = await createApiKey(db, { tenantId, plan: 'free', ownerUserId: 'mem-bystander', name: 'bystander key' })
    } finally {
      await db.release()
    }

    expect(await verifyApiKey(victim.plaintext, tenantId), 'the key works while the member exists').not.toBeNull()

    const res = await app.inject({ method: 'DELETE', url: '/members/mem-keyed', headers: { host, cookie: cookie(adminSid) } })
    expect(res.statusCode).toBe(204)

    expect(await verifyApiKey(victim.plaintext, tenantId), 'the removed member\'s key no longer authenticates').toBeNull()
    expect(await verifyApiKey(bystander.plaintext, tenantId), "another member's key is untouched").not.toBeNull()

    // revoked, not deleted — the row stays auditable, exactly as a self-service revoke leaves it
    await admin`SELECT set_config('app.tenant_id', ${tenantId}, false)`
    const [row] = await admin<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM api_keys WHERE id = ${victim.id}`
    expect(row?.revoked_at, 'the key row survives, marked revoked').not.toBeNull()

    // the revocation is in the compliance ledger next to member.removed (same in-tx writer)
    await drainAuditFor(admin, tenantId)
    const audit = await admin<{ action: string; target: string }[]>`
      SELECT action, target FROM audit_log WHERE tenant_id = ${tenantId} AND action = 'api_key.revoked'`
    expect(audit.some((a) => a.target === `api_key:${victim.id}`), 'the revoke is audited').toBe(true)

    // removing a member with no live keys is a no-op (no double-revoke, no error)
    const again = await app.inject({ method: 'DELETE', url: '/members/mem-bystander', headers: { host, cookie: cookie(adminSid) } })
    expect(again.statusCode).toBe(204)
  })

  // #474: the same sub can exist in two tenants (one shared IdP — the premise ADR-176 works from), so the
  // sweep must be tenant-scoped in fact, not just in intent. RLS is what makes that true; this pins it.
  it('#474: revoking on removal is tenant-scoped — the same sub keeps its key in another tenant', async () => {
    const otherSlug = `p14mem2-${Date.now().toString(36)}`
    const { tenantId: otherId } = await provisionTenant(fgaClient, { slug: otherSlug, admin: { sub: 'mem-other-admin' } })
    await admin`SELECT set_config('app.tenant_id', ${otherId}, false)`
    await admin`INSERT INTO members (tenant_id, sub, role) VALUES (${otherId}, 'mem-shared', 'member')
                ON CONFLICT (tenant_id, sub) DO NOTHING`
    await writeTuples(fgaClient, [{ user: 'user:mem-shared', relation: 'member', object: `tenant:${otherId}` }])
    await seedMember('mem-shared', 'member') // …and in THIS tenant

    const here = await acquireTenantDb({ id: tenantId, slug, plan: 'free', isolation: 'logical' } as never)
    const there = await acquireTenantDb({ id: otherId, slug: otherSlug, plan: 'free', isolation: 'logical' } as never)
    let keyHere: Awaited<ReturnType<typeof createApiKey>>
    let keyThere: Awaited<ReturnType<typeof createApiKey>>
    try {
      keyHere = await createApiKey(here, { tenantId, plan: 'free', ownerUserId: 'mem-shared', name: 'here' })
      keyThere = await createApiKey(there, { tenantId: otherId, plan: 'free', ownerUserId: 'mem-shared', name: 'there' })
    } finally {
      await here.release()
      await there.release()
    }

    const res = await app.inject({ method: 'DELETE', url: '/members/mem-shared', headers: { host, cookie: cookie(adminSid) } })
    expect(res.statusCode).toBe(204)
    expect(await verifyApiKey(keyHere.plaintext, tenantId), 'the removing tenant\'s key is revoked').toBeNull()
    expect(await verifyApiKey(keyThere.plaintext, otherId), "the other tenant's key for the SAME sub survives").not.toBeNull()

    await deleteTuples(fgaClient, [{ user: 'user:mem-shared', relation: 'member', object: `tenant:${otherId}` }]).catch(() => {})
  }, 60_000)
})

// ── #614: the list carries each row's status — password entrance / origin / suspended ────────────
// Real rows, read back through the route (no hardcoded expectation table): a credential row IS
// has_password, migration 083's column IS the origin, migration 037's timestamp IS suspended.
describe('member status columns (#614)', () => {
  it('reports has_password / identity_source / deactivated_at from real rows', async () => {
    await admin`SELECT set_config('app.tenant_id', ${tenantId}, false)`
    // a password-born local user (the CHECK demands the reserved wlocal_ prefix) + a suspended member
    await admin`INSERT INTO members (tenant_id, sub, role, identity_source) VALUES
      (${tenantId}, 'wlocal_614', 'member', 'local') ON CONFLICT (tenant_id, sub) DO NOTHING`
    await admin`INSERT INTO members (tenant_id, sub, role, deactivated_at) VALUES
      (${tenantId}, 'mem-suspended-614', 'member', now()) ON CONFLICT (tenant_id, sub) DO NOTHING`
    await admin`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
      VALUES (${tenantId}, 'wlocal_614', 'p614@x.test', 'scrypt$unusable-fixture-hash')
      ON CONFLICT (tenant_id, member_sub) DO NOTHING`

    const res = await app.inject({ method: 'GET', url: '/members', headers: { host, cookie: cookie(adminSid) } })
    expect(res.statusCode).toBe(200)
    const members = res.json().members as { sub: string; identity_source: string; has_password: boolean; deactivated_at: string | null }[]

    const local = members.find((m) => m.sub === 'wlocal_614')
    expect(local, 'the local user is listed').toBeTruthy()
    expect(local!.identity_source).toBe('local')
    expect(local!.has_password, 'a credential row reads back as has_password').toBe(true)
    expect(local!.deactivated_at).toBeNull()

    const suspended = members.find((m) => m.sub === 'mem-suspended-614')!
    expect(suspended.identity_source, "083's default: every pre-local member is IdP-born").toBe('oidc')
    expect(suspended.has_password).toBe(false)
    expect(suspended.deactivated_at, 'a frozen member says so instead of looking alive').not.toBeNull()

    // the join is a LEFT join: members without a credential still list, as false rather than absent
    const adminRow = members.find((m) => m.sub === 'mem-admin')!
    expect(adminRow.has_password).toBe(false)
  })
})

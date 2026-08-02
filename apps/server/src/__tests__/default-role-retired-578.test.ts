// #578 / ADR-201 rev3 slice 5: the tenant default role is retired.
//
// It conferred a tenant-scope custom role on every member no group mapping matched. The tenant
// vocabulary is `createSpaces` and `issueApiKeys`, and the admin screen already carries an every-member
// toggle for each — two controls, one meaning, and ADR-201 kept the toggles.
//
// The ruling's condition was that existing settings be CONVERTED, not dropped, and the conversion has
// two halves because the state lives in two stores: the assignments (Postgres, migration 100) and the
// intent (FGA, the one-shot toggle script). Both halves are pinned, along with the surface being gone
// and the toggles still working — a retirement is only safe when the thing it leaned on still stands.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
const ROOT = resolve(import.meta.dirname, '../../../..')

let app: FastifyInstance
let db: TenantDb

// The tenant handle is acquired and released like every other suite here: `pool.end()` in afterAll
// hangs the hook if the pool still has a client checked out, which is how this file first reported
// "7 passed" and a failed FILE.
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb({ id: 'tenant_dev', slug: 'tenant_dev', plan: 'business', isolation: 'logical' } as Tenant)
}, 120_000)
afterAll(async () => { await db.release(); await app.close(); await admin.end(); await pool.end() }, 120_000)

describe('#578: the default-role surface is gone', () => {
  it('GET /admin/roles/default-role is not a route any more', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/roles/default-role', headers: H })
    expect(res.statusCode).toBe(404)
  }, 60_000)

  it('PUT /admin/roles/default-role is not a route any more', async () => {
    const res = await app.inject({ method: 'PUT', url: '/admin/roles/default-role', headers: H, payload: { defaultRoleId: null } })
    expect(res.statusCode).toBe(404)
  }, 60_000)
})

describe('#578: what it was replaced BY still works', () => {
  it('the every-member toggles read and write', async () => {
    const before = await app.inject({ method: 'GET', url: '/admin/roles/tenant-defaults', headers: H })
    expect(before.statusCode).toBe(200)
    const start = (before.json() as { member: { createSpaces: boolean } }).member.createSpaces
    try {
      const put = await app.inject({
        method: 'PUT', url: '/admin/roles/tenant-defaults', headers: H,
        payload: { memberCreateSpaces: !start },
      })
      expect(put.statusCode).toBeLessThan(300)
      const after = await app.inject({ method: 'GET', url: '/admin/roles/tenant-defaults', headers: H })
      expect((after.json() as { member: { createSpaces: boolean } }).member.createSpaces).toBe(!start)
    } finally {
      await app.inject({ method: 'PUT', url: '/admin/roles/tenant-defaults', headers: H, payload: { memberCreateSpaces: start } })
    }
  }, 60_000)
})

describe('#578: the conversion keeps what people had', () => {
  const sqlMig = readFileSync(resolve(ROOT, 'infra/db/migrations/100_retire_default_role.sql'), 'utf8')
  const script = readFileSync(resolve(ROOT, 'infra/openfga/migrate-578-default-role-toggles.ts'), 'utf8')

  it('the assignments are re-owned, never deleted', () => {
    expect(sqlMig).toMatch(/UPDATE role_assignments SET origin = 'manual'/)
    expect(sqlMig, 'a retired evaluator must not take its grants with it').not.toMatch(/DELETE FROM role_assignments/)
  })

  it('the column outlives its readers (the #499 rule)', () => {
    expect(sqlMig).not.toMatch(/DROP COLUMN/i)
  })

  it('the FGA half writes the member toggles the default role stood for', () => {
    expect(script).toMatch(/space_creator/)
    expect(script).toMatch(/api_key_issue/)
    expect(script, 'addressed at the tenant MEMBER set, not user:* (#471)').toMatch(/tenant:\$\{tenantId\}#member/)
  })

  it('the FGA half is idempotent — it reads before it writes', () => {
    // OpenFGA 400s a duplicate write, which would abort a whole tenant mid-conversion (#574's lesson)
    expect(script).toMatch(/\.read\(/)
    expect(script).toMatch(/have\.has\(/)
  })
})

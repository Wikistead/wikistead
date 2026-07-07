// Integration test — real Postgres (docker compose up -d). RLS is a security boundary, so it is
// verified against actual Postgres policy evaluation, not a mock. #247 / ADR-110: the `templates` table
// carries tenant isolation via the same tenant_isolation policy as 045_usage_counters — a tenant-scoped
// connection must not READ / DELETE / UPDATE another tenant's template, nor INSERT one for it.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb } from '../db/tenant-db.js'

afterAll(() => pool.end())

describe('cross-tenant RLS enforcement (templates)', () => {
  const tenantDev = { id: 'tenant_dev', slug: 'dev', isolation: 'logical' as const, plan: 'free' }
  const admin = postgres(process.env.DATABASE_ADMIN_URL!)
  const devName = `tpl-dev-${Date.now().toString(36)}`
  const acmeName = `tpl-acme-${Date.now().toString(36)}`
  let acmeId = ''

  beforeAll(async () => {
    // Insert templates for BOTH tenants via the admin role (bypasses RLS).
    await admin`INSERT INTO templates (tenant_id, name, body_md, scope, created_by) VALUES ('tenant_dev', ${devName}, '# dev', 'personal', 'user:dev')`
    const [a] = await admin<{ id: string }[]>`INSERT INTO templates (tenant_id, name, body_md, scope, created_by) VALUES ('tenant_acme', ${acmeName}, '# acme', 'tenant', 'user:acme') RETURNING id`
    acmeId = a.id
  }, 30_000)
  afterAll(async () => {
    await admin`DELETE FROM templates WHERE name IN (${devName}, ${acmeName})`.catch(() => {})
    await admin`DELETE FROM templates WHERE tenant_id = 'tenant_dev' AND name = 'tpl-evil'`.catch(() => {})
    await admin.end()
  }, 30_000)

  it('READ isolation: a tenant-scoped conn sees only its own templates, not another tenant’s (even by PK)', async () => {
    const db = await acquireTenantDb(tenantDev)
    try {
      const names = (await db.sql<{ name: string }[]>`SELECT name FROM templates`).map((r) => r.name)
      expect(names).toContain(devName)
      expect(names).not.toContain(acmeName)
      const byPk = await db.sql`SELECT id FROM templates WHERE id = ${acmeId}`
      expect(byPk.length).toBe(0)
    } finally {
      await db.release()
    }
  })

  it('WRITE isolation: cannot INSERT a template for another tenant (USING-as-WITH-CHECK)', async () => {
    const db = await acquireTenantDb(tenantDev)
    try {
      await expect(db.sql`INSERT INTO templates (tenant_id, name, body_md, scope, created_by) VALUES ('tenant_acme', 'tpl-evil', '# x', 'personal', 'user:dev')`)
        .rejects.toThrow()
    } finally {
      await db.release()
    }
  })

  it('DELETE/UPDATE isolation: cannot affect another tenant’s template (USING filters it out)', async () => {
    const db = await acquireTenantDb(tenantDev)
    try {
      const del = await db.sql`DELETE FROM templates WHERE id = ${acmeId}`
      expect(del.count).toBe(0)
      const upd = await db.sql`UPDATE templates SET name = 'hijacked' WHERE id = ${acmeId}`
      expect(upd.count).toBe(0)
    } finally {
      await db.release()
    }
  })

  it('scope CHECK rejects an unknown scope', async () => {
    await expect(admin`INSERT INTO templates (tenant_id, name, body_md, scope, created_by) VALUES ('tenant_dev', 'tpl-bad-scope', '# x', 'galaxy', 'user:dev')`)
      .rejects.toThrow()
  })
})

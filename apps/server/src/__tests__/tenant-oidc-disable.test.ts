// Integration test (real Postgres) — break-glass tenant OIDC disable (#105 / ADR-060).
// Verifies the operator recovery actually flips the login gate, PRESERVES the config
// (disable-only, not cleared), is idempotent, grants no access (seats no one), audits
// the action, and refuses an unknown tenant. The admin connection bypasses RLS exactly
// as the CLI runs (no tenant session).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { onDomainEvent, type DomainEvent } from '@wikistead/events'
import { disableTenantOidc } from '../scripts/oidc-disable.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const created: string[] = []

async function freshTenant(slug: string): Promise<string> {
  const [t] = await admin<{ id: string }[]>`INSERT INTO tenants (slug, plan) VALUES (${slug}, 'free') RETURNING id`
  created.push(t.id)
  return t.id
}
async function enableOidc(tenantId: string): Promise<void> {
  await admin`
    INSERT INTO tenant_oidc (tenant_id, issuer, client_id, redirect_uri, enabled)
    VALUES (${tenantId}, 'https://idp.test/', 'client-abc', 'https://app.test/cb', true)
  `
}

beforeAll(async () => {}, 30_000)
afterAll(async () => {
  for (const id of created) {
    await admin`DELETE FROM tenant_oidc WHERE tenant_id = ${id}`.catch(() => {})
    await admin`DELETE FROM members WHERE tenant_id = ${id}`.catch(() => {})
    await admin`DELETE FROM tenants WHERE id = ${id}`.catch(() => {})
  }
  await admin.end()
}, 30_000)

describe('disableTenantOidc (break-glass)', () => {
  it('disables a locked-out tenant\'s OIDC, preserving config, and audits it', async () => {
    const slug = `bg-on-${Date.now().toString(36)}`
    const tenantId = await freshTenant(slug)
    await enableOidc(tenantId)
    // A seated member, to prove break-glass seats no one (grants no access).
    await admin`INSERT INTO members (tenant_id, sub, role) VALUES (${tenantId}, 'm1', 'member')`
    const seatsBefore = (await admin`SELECT 1 FROM members WHERE tenant_id = ${tenantId}`).length

    const events: DomainEvent[] = []
    const off = onDomainEvent((e) => { if (e.type === 'tenant.oidc_recovered') events.push(e) })
    try {
      const r = await disableTenantOidc(admin, { slug, operator: 'op-jane' })
      expect(r).toMatchObject({ tenantId, slug, hadConfig: true, changed: true })
    } finally {
      off()
    }

    // Login gate flipped off...
    const [row] = await admin<{ enabled: boolean; issuer: string; client_id: string }[]>`
      SELECT enabled, issuer, client_id FROM tenant_oidc WHERE tenant_id = ${tenantId}
    `
    expect(row.enabled).toBe(false)
    // ...but the config is PRESERVED (disable-only), so the admin can re-enable after fixing.
    expect(row.issuer).toBe('https://idp.test/')
    expect(row.client_id).toBe('client-abc')
    // Grants no access: no seat added/removed.
    expect((await admin`SELECT 1 FROM members WHERE tenant_id = ${tenantId}`).length).toBe(seatsBefore)
    // Audited (who/tenant).
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'tenant.oidc_recovered', tenantId, operator: 'op-jane' })
  })

  it('is idempotent: a second run is a no-op and emits no further audit event', async () => {
    const slug = `bg-idem-${Date.now().toString(36)}`
    const tenantId = await freshTenant(slug)
    await enableOidc(tenantId)
    await disableTenantOidc(admin, { slug, operator: 'op' }) // first run disables

    const events: DomainEvent[] = []
    const off = onDomainEvent((e) => { if (e.type === 'tenant.oidc_recovered') events.push(e) })
    try {
      const r = await disableTenantOidc(admin, { slug, operator: 'op' })
      expect(r).toMatchObject({ hadConfig: true, changed: false }) // already disabled
    } finally {
      off()
    }
    expect(events).toHaveLength(0) // no audit spam on re-run
  })

  it('a tenant with no OIDC config is a no-op (hadConfig:false)', async () => {
    const slug = `bg-none-${Date.now().toString(36)}`
    await freshTenant(slug)
    const r = await disableTenantOidc(admin, { slug, operator: 'op' })
    expect(r).toMatchObject({ hadConfig: false, changed: false })
  })

  it('refuses an unknown tenant slug (no silent success)', async () => {
    await expect(disableTenantOidc(admin, { slug: `bg-missing-${Date.now().toString(36)}`, operator: 'op' }))
      .rejects.toMatchObject({ code: 'tenant_not_found' })
  })
})

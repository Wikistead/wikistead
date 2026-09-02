// ADR-252 §1 / #810: resetTenant — the tenant:reset CLI's core (cliMain is a thin argv/exit wrapper
// around this, not separately tested here). Integration (real Postgres + real FGA + real search +
// real storage + the real operator ledger).
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { deleteObjectTuples, fgaClient } from '@wikistead/authz'
import { readOperatorChain } from '../audit/operator-ledger.js'
import { resetTenant } from '../scripts/tenant-reset.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_t810cl'
const SLUG = 't810cl'
const doomedSpace = 'space_t810cl_doomed'
const doomedPage = 'page_t810cl_doomed'

async function seedTenant(isolation: 'logical' | 'namespace' = 'logical'): Promise<void> {
  await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${TENANT}, ${SLUG}, 'business', ${isolation})
    ON CONFLICT (slug) DO UPDATE SET isolation = EXCLUDED.isolation`
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${doomedSpace}, ${TENANT}, ${doomedSpace}) ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc) VALUES (${doomedPage}, ${TENANT}, ${doomedSpace}, 't', ${Buffer.from([])}) ON CONFLICT (id) DO NOTHING`
}

afterAll(async () => {
  for (const tbl of ['pages', 'spaces']) await admin.unsafe(`DELETE FROM ${tbl} WHERE tenant_id = '${TENANT}'`).catch(() => {})
  await admin`DELETE FROM tenant_sweep_progress WHERE manifest_id IN (SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT})`.catch(() => {})
  await admin`DELETE FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await deleteObjectTuples(fgaClient, `space:${doomedSpace}`).catch(() => {})
  await admin.end()
})

describe('resetTenant (ADR-252 §1, #810)', () => {
  it('refuses an unknown slug', async () => {
    await expect(resetTenant(admin, { slug: 'no-such-tenant-t810cl', confirm: 'no-such-tenant-t810cl', operator: 'test' }))
      .rejects.toMatchObject({ code: 'tenant_not_found' })
  })

  it('refuses a confirmation that does not match the slug', async () => {
    await seedTenant()
    await expect(resetTenant(admin, { slug: SLUG, confirm: 'wrong-slug', operator: 'test' }))
      .rejects.toMatchObject({ code: 'wrong_confirmation' })
    // refusal touches nothing — the page is still there
    const stillThere = await admin<{ id: string }[]>`SELECT id FROM pages WHERE id = ${doomedPage}`
    expect(stillThere).toHaveLength(1)
  })

  it('refuses a namespace-isolated tenant', async () => {
    await seedTenant('namespace')
    await expect(resetTenant(admin, { slug: SLUG, confirm: SLUG, operator: 'test' }))
      .rejects.toMatchObject({ code: 'namespace_isolated' })
    const stillThere = await admin<{ id: string }[]>`SELECT id FROM pages WHERE id = ${doomedPage}`
    expect(stillThere, 'refused before touching anything').toHaveLength(1)
  })

  it('sweeps a logical-isolation tenant end to end and records both operator-ledger entries', async () => {
    await seedTenant('logical')
    const before = (await readOperatorChain(admin)).entries.length

    const result = await resetTenant(admin, { slug: SLUG, confirm: SLUG, operator: 'test-operator' })

    expect(result.doomedSpaceCount).toBe(1)
    expect(result.sweptPageCount).toBe(1)
    expect(result.fullyComplete).toBe(false)

    const remainingPage = await admin<{ id: string }[]>`SELECT id FROM pages WHERE id = ${doomedPage}`
    expect(remainingPage, 'the sweep actually ran').toEqual([])

    const { entries, verdict } = await readOperatorChain(admin)
    expect(verdict.valid, 'the ledger still verifies after these two new entries').toBe(true)
    expect(entries.length).toBe(before + 2)
    const mine = entries.slice(-2)
    expect(mine.map((e) => e.action)).toEqual(['tenant.reset_started', 'tenant.reset_swept'])
    for (const e of mine) {
      expect(e.actor).toBe('operator:test-operator')
      expect(e.target).toBe(`tenant:${TENANT}`)
    }

    const [progress] = await admin<{ database_done: boolean; fga_done: boolean; search_done: boolean; storage_done: boolean }[]>`
      SELECT database_done, fga_done, search_done, storage_done FROM tenant_sweep_progress WHERE manifest_id = ${result.manifestId}`
    expect(progress).toEqual({ database_done: true, fga_done: true, search_done: true, storage_done: true })
  })
})

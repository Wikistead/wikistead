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

  // review c-af763a4 (D2/D3): the original commit shipped with ZERO test coverage of the
  // --keep argument through this entry point — a mutation deleting the wiring entirely left every
  // test in this file and tenant-sweep-run-sweep-810.test.ts green. These two tests close that gap.
  describe('--keep validation (D2/D3)', () => {
    const kept = { space: 'space_t810cl_kept', page: 'page_t810cl_kept' }
    const doomed2 = { space: 'space_t810cl_doomed2', page: 'page_t810cl_doomed2' }

    it('a valid keep-list protects the named space\'s row while its page is still swept (corrected §1 semantics)', async () => {
      await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${TENANT}, ${SLUG}, 'business', 'logical')
        ON CONFLICT (slug) DO UPDATE SET isolation = 'logical'`
      for (const s of [kept, doomed2]) {
        await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${s.space}, ${TENANT}, ${s.space}) ON CONFLICT (id) DO NOTHING`
        await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc) VALUES (${s.page}, ${TENANT}, ${s.space}, 't', ${Buffer.from([])}) ON CONFLICT (id) DO NOTHING`
      }

      const result = await resetTenant(admin, { slug: SLUG, confirm: SLUG, keepSlugsOrIds: [kept.space], operator: 'test' })
      expect(result.keptSpaceCount).toBe(1)

      const remainingSpaces = await admin<{ id: string }[]>`SELECT id FROM spaces WHERE tenant_id = ${TENANT}`
      expect(remainingSpaces.map((r) => r.id)).toEqual([kept.space])
      const remainingPages = await admin<{ id: string }[]>`SELECT id FROM pages WHERE tenant_id = ${TENANT}`
      expect(remainingPages, "the kept space's own page is still swept — only its row survives").toEqual([])
    })

    it('⚠️ break-check / D2: an invalid --keep id is refused BEFORE anything is written, not silently treated as protecting nothing', async () => {
      await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${TENANT}, ${SLUG}, 'business', 'logical')
        ON CONFLICT (slug) DO UPDATE SET isolation = 'logical'`
      const real = { space: 'space_t810cl_realkeep', page: 'page_t810cl_realkeep' }
      await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${real.space}, ${TENANT}, ${real.space}) ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc) VALUES (${real.page}, ${TENANT}, ${real.space}, 't', ${Buffer.from([])}) ON CONFLICT (id) DO NOTHING`

      // a one-character typo on the real space id — the exact shape review c-af763a4
      // reproduced live, which without this check would have swept `real.space` anyway while
      // reporting "1 space(s) kept"
      const typo = real.space.slice(0, -1) + 'X'
      await expect(resetTenant(admin, { slug: SLUG, confirm: SLUG, keepSlugsOrIds: [typo], operator: 'test' }))
        .rejects.toMatchObject({ code: 'invalid_keep_id' })

      const stillThere = await admin<{ id: string }[]>`SELECT id FROM spaces WHERE id = ${real.space}`
      expect(stillThere, 'refused before touching anything — the real space (which the typo\'d id was meant to protect) is untouched').toHaveLength(1)
    })
  })

  // review c-af763a4 (D1): a crash between the database step and the other three would
  // otherwise let a second invocation compute an empty doomed set (the rows are already gone) and
  // report false success while orphaning the first manifest's storage/FGA cleanup.
  it('⚠️ D1: refuses to start a second sweep while a prior one for this tenant is unfinished', async () => {
    await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${TENANT}, ${SLUG}, 'business', 'logical')
      ON CONFLICT (slug) DO UPDATE SET isolation = 'logical'`
    const before = await admin<{ id: string }[]>`SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT} AND operation = 'reset'`
    const [m] = await admin<{ id: string }[]>`
      INSERT INTO tenant_sweep_manifests (tenant_id, operation, fga_object_ids, storage_keys, search_document_ids)
      VALUES (${TENANT}, 'reset', ${[]}, ${[]}, ${[]}) RETURNING id`
    // simulate a crash right after the database step committed
    await admin`INSERT INTO tenant_sweep_progress (manifest_id, database_done) VALUES (${m.id}, true)`

    await expect(resetTenant(admin, { slug: SLUG, confirm: SLUG, operator: 'test' }))
      .rejects.toMatchObject({ code: 'unfinished_sweep_exists' })

    // no THIRD manifest was created by the refused call (before + the one we just inserted by hand)
    const after = await admin<{ id: string }[]>`SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT} AND operation = 'reset'`
    expect(after.length).toBe(before.length + 1)
  })
})

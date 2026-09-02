// ADR-252 §1 / #810: resetTenant — the tenant:reset CLI's core (cliMain is a thin argv/exit wrapper
// around this, not separately tested here). Integration (real Postgres + real FGA + real search +
// real storage + the real operator ledger).
import { describe, it, expect, afterAll } from 'vitest'
import postgres from 'postgres'
import { deleteObjectTuples, fgaClient, writeTuples, readObjectTuples } from '@wikistead/authz'
import { readOperatorChain } from '../audit/operator-ledger.js'
import { resetTenant, tenantResetLockKey } from '../scripts/tenant-reset.js'
import { writeResetManifest } from '../tenant-sweep/write-manifest.js'
import { executeDatabaseSweep } from '../tenant-sweep/execute-database.js'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'

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

  // review c-af763a4 (4th pass, F2): the 3rd pass's fix (D1) only refused a second sweep while
  // one was unfinished — leaving no way to actually FINISH an interrupted one, contradicting ADR-252
  // Acceptance's own "a re-run finishes it". This describe covers the resume behavior that replaced it.
  describe('resuming an unfinished sweep (F2)', () => {
    const resumeSpace = 'space_t810cl_resume'
    const resumePage = 'page_t810cl_resume'

    it('resumes the SAME manifest and finishes the remaining stores, rather than refusing or starting a second one', async () => {
      await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${TENANT}, ${SLUG}, 'business', 'logical')
        ON CONFLICT (slug) DO UPDATE SET isolation = 'logical'`
      await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${resumeSpace}, ${TENANT}, ${resumeSpace}) ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc) VALUES (${resumePage}, ${TENANT}, ${resumeSpace}, 't', ${Buffer.from([])}) ON CONFLICT (id) DO NOTHING`
      await writeTuples(fgaClient, [{ user: 'user:dev-user', relation: 'manager', object: `space:${resumeSpace}` }])
      const search = new LogicalSearchDriver()
      const storage = new LogicalStorageDriver()
      await search.upsertDoc({ id: resumePage, tenantId: TENANT, spaceId: resumeSpace, title: 't', body: '', viewerUsers: ['user:dev-user'], viewerGroups: [], isPublic: false, updatedAt: Date.now() })

      // Simulate a crash right after the database step committed: write a real manifest (so
      // fga_object_ids/storage_keys/search_document_ids are the genuine doomed set, not an empty
      // stand-in) and run ONLY the database step directly, the same way runResetSweep would have —
      // then stop, exactly where a killed process would have.
      const { manifestId, doomed } = await writeResetManifest(admin, TENANT, [])
      await executeDatabaseSweep(admin, manifestId, TENANT, doomed)
      const [pageGoneAlready] = await admin<{ id: string }[]>`SELECT id FROM pages WHERE id = ${resumePage}`
      expect(pageGoneAlready, 'the simulated crash really did complete the database step').toBeUndefined()
      // FGA/search/storage are DELIBERATELY still live — nothing beyond the database step ran
      expect(await readObjectTuples(fgaClient, `space:${resumeSpace}`), 'FGA not yet swept').not.toEqual([])

      const before = await admin<{ id: string }[]>`SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT} AND operation = 'reset'`

      const result = await resetTenant(admin, { slug: SLUG, confirm: SLUG, operator: 'test-resume' })
      expect(result.manifestId, 'the SAME manifest is resumed, not a new one').toBe(manifestId)

      // no second manifest was created
      const after = await admin<{ id: string }[]>`SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT} AND operation = 'reset'`
      expect(after.length).toBe(before.length)

      // the remaining three stores actually ran
      expect(await readObjectTuples(fgaClient, `space:${resumeSpace}`), 'FGA now swept by the resume').toEqual([])
      const [progress] = await admin<{ database_done: boolean; fga_done: boolean; search_done: boolean; storage_done: boolean }[]>`
        SELECT database_done, fga_done, search_done, storage_done FROM tenant_sweep_progress WHERE manifest_id = ${manifestId}`
      expect(progress).toEqual({ database_done: true, fga_done: true, search_done: true, storage_done: true })

      const { entries } = await readOperatorChain(admin)
      expect(entries.some((e) => e.action === 'tenant.reset_resumed' && e.actor === 'operator:test-resume'), 'the ledger records this as a resume, not a fresh start').toBe(true)
    })

    it('⚠️ refuses to resume with a --keep list that does not match what the unfinished manifest recorded', async () => {
      await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${TENANT}, ${SLUG}, 'business', 'logical')
        ON CONFLICT (slug) DO UPDATE SET isolation = 'logical'`
      const somewhereElse = 'space_t810cl_mismatch_target'
      await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${somewhereElse}, ${TENANT}, ${somewhereElse}) ON CONFLICT (id) DO NOTHING`
      const [m] = await admin<{ id: string }[]>`
        INSERT INTO tenant_sweep_manifests (tenant_id, operation, keep_space_ids, fga_object_ids, storage_keys, search_document_ids)
        VALUES (${TENANT}, 'reset', ${[somewhereElse]}, ${[]}, ${[]}, ${[]}) RETURNING id`
      await admin`INSERT INTO tenant_sweep_progress (manifest_id, database_done) VALUES (${m.id}, true)`

      // this invocation passes NO --keep — different from the manifest's recorded [somewhereElse]
      await expect(resetTenant(admin, { slug: SLUG, confirm: SLUG, operator: 'test' }))
        .rejects.toMatchObject({ code: 'unfinished_sweep_keep_mismatch' })

      // refused before touching anything — the space named on the (mismatched, unresumed) manifest is untouched
      const stillThere = await admin<{ id: string }[]>`SELECT id FROM spaces WHERE id = ${somewhereElse}`
      expect(stillThere).toHaveLength(1)

      // This manifest is DELIBERATELY left unfinished by this test (that's the whole point) — clean it
      // up so it doesn't count as "the tenant's unfinished sweep" for every test that runs after this
      // one in this shared-tenant file (measured: without this, the very next test's two concurrent
      // calls both hit THIS manifest's mismatch instead of racing each other, 0 new manifests either
      // way — a real cross-test leak, not a hypothetical one).
      await admin`DELETE FROM tenant_sweep_progress WHERE manifest_id = ${m.id}`
      await admin`DELETE FROM tenant_sweep_manifests WHERE id = ${m.id}`
    })

    // review c-af763a4 (4th pass, F3): the unfinished-sweep query used to be an INNER JOIN,
    // which could not see a manifest with NO progress row at all — write-manifest.ts's insert is now
    // one atomic statement, making that shape unreachable through normal code, but "a defence that
    // depends on only one of two independent fixes holding is not a defence" (this file's own header
    // note): the LEFT JOIN this test pins holds even if write-manifest.ts's atomicity fix regresses.
    it('treats a manifest with NO progress row at all as unfinished too (LEFT JOIN, not INNER JOIN)', async () => {
      await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${TENANT}, ${SLUG}, 'business', 'logical')
        ON CONFLICT (slug) DO UPDATE SET isolation = 'logical'`
      const [m] = await admin<{ id: string }[]>`
        INSERT INTO tenant_sweep_manifests (tenant_id, operation, keep_space_ids, fga_object_ids, storage_keys, search_document_ids)
        VALUES (${TENANT}, 'reset', ${[]}, ${[]}, ${[]}, ${[]}) RETURNING id`
      // deliberately NO tenant_sweep_progress row — simulates write-manifest.ts's OLD two-statement
      // insert dying between the two, the exact shape the atomicity fix removed

      const before = await admin<{ id: string }[]>`SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT} AND operation = 'reset'`

      const result = await resetTenant(admin, { slug: SLUG, confirm: SLUG, operator: 'test-nojoin' })
      expect(result.manifestId, 'the progress-less manifest is resumed, not skipped past').toBe(m.id)

      const after = await admin<{ id: string }[]>`SELECT id FROM tenant_sweep_manifests WHERE tenant_id = ${TENANT} AND operation = 'reset'`
      expect(after.length, 'no second manifest was created').toBe(before.length)

      const [progress] = await admin<{ database_done: boolean; fga_done: boolean; search_done: boolean; storage_done: boolean }[]>`
        SELECT database_done, fga_done, search_done, storage_done FROM tenant_sweep_progress WHERE manifest_id = ${m.id}`
      expect(progress, 'a progress row now exists and every step ran (there was nothing in this empty manifest to sweep)').toEqual({ database_done: true, fga_done: true, search_done: true, storage_done: true })
    })

    // review c-af763a4 (5th pass, G2, reproduced live): the --keep existence check used to run
    // unconditionally, before the unfinished-sweep decision — so a kept space's row gone by ANY means
    // (not just this sweep; e.g. a separate admin action) between the database step committing and a
    // resume attempt made `--keep=X` refuse (existence check: X is gone) AND no `--keep` refuse
    // (keep-list mismatch against the manifest's recorded [X]) — no input could ever finish that sweep.
    it('⚠️ G2 break-check: resuming with the recorded --keep still works even if that space\'s row is independently gone by the time of the resume', async () => {
      await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${TENANT}, ${SLUG}, 'business', 'logical')
        ON CONFLICT (slug) DO UPDATE SET isolation = 'logical'`
      const keptButDoomedLater = 'space_t810cl_g2_kept'
      const otherDoomed = { space: 'space_t810cl_g2_other', page: 'page_t810cl_g2_other' }
      await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${keptButDoomedLater}, ${TENANT}, ${keptButDoomedLater}) ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${otherDoomed.space}, ${TENANT}, ${otherDoomed.space}) ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO pages (id, tenant_id, space_id, title, ydoc) VALUES (${otherDoomed.page}, ${TENANT}, ${otherDoomed.space}, 't', ${Buffer.from([])}) ON CONFLICT (id) DO NOTHING`

      // start a real --keep=[keptButDoomedLater] reset, run only the database step (simulating a crash
      // right after it), leaving fga/search/storage unfinished
      const { manifestId, doomed } = await writeResetManifest(admin, TENANT, [keptButDoomedLater])
      await executeDatabaseSweep(admin, manifestId, TENANT, doomed)
      const [stillKept] = await admin<{ id: string }[]>`SELECT id FROM spaces WHERE id = ${keptButDoomedLater}`
      expect(stillKept, 'the kept space survives the database step, as designed').toBeDefined()

      // now the kept space's row is removed by some OTHER means entirely (an admin deleting it
      // directly, a different process — anything other than this sweep)
      await admin`DELETE FROM spaces WHERE id = ${keptButDoomedLater}`

      // resuming with the SAME --keep this manifest recorded must still succeed — it no longer
      // re-validates the requested list's existence against live rows on the resume path
      const result = await resetTenant(admin, { slug: SLUG, confirm: SLUG, keepSlugsOrIds: [keptButDoomedLater], operator: 'test-g2' })
      expect(result.manifestId).toBe(manifestId)

      const [progress] = await admin<{ database_done: boolean; fga_done: boolean; search_done: boolean; storage_done: boolean }[]>`
        SELECT database_done, fga_done, search_done, storage_done FROM tenant_sweep_progress WHERE manifest_id = ${manifestId}`
      expect(progress, 'the sweep actually finished').toEqual({ database_done: true, fga_done: true, search_done: true, storage_done: true })
    })
  })

  // review c-af763a4 (4th pass, F1, reproduced live): two concurrent `resetTenant` calls for
  // the same tenant used to both pass the (lock-free) unfinished-sweep check and both write their own
  // manifest — a `--keep` call racing a no-`--keep` call swept the space the first call reported as
  // kept.
  //
  // ⚠️ 5th pass (G1): the original version of this test raced two real `resetTenant` calls with
  // `Promise.allSettled` and asserted the outcome — timing-dependent, and measured to pass 3-of-4 runs
  // even with the lock line deleted outright (the two calls' critical sections, on this shared,
  // already-warmed tenant, usually didn't actually overlap). A pin that goes green most of the time
  // with the real defect present is not a pin. Replaced with a deterministic version: hold
  // `tenantResetLockKey`'s own lock on a SEPARATE connection first, so `resetTenant` is FORCED to
  // block on it, and assert it is still blocked after a wait — not "usually finishes in the right
  // order".
  it('⚠️ F1 break-check: resetTenant genuinely blocks on the held per-tenant lock, not merely usually', async () => {
    await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${TENANT}, ${SLUG}, 'business', 'logical')
      ON CONFLICT (slug) DO UPDATE SET isolation = 'logical'`

    const holder = postgres(process.env.DATABASE_ADMIN_URL!)
    let releaseHolder!: () => void
    const releaseSignal = new Promise<void>((resolve) => { releaseHolder = resolve })
    const holderTx = holder.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${tenantResetLockKey(TENANT)})`
      await releaseSignal
    })

    // `finally` must ALWAYS release the holder and let `holderTx` finish before closing that
    // connection, even when the assertion below throws — otherwise `holder.end()` hangs forever
    // waiting on a transaction that is itself waiting on a signal nothing else will ever send,
    // timing this whole test out instead of reporting the actual assertion failure (measured while
    // writing this break-check: `holder.end()` alone hung past vitest's 5s default with the lock
    // disabled, because the early `expect` throw skipped the `releaseHolder()` call below it).
    let settled = false
    try {
      // give the holder a moment to actually acquire the lock before racing resetTenant against it
      await new Promise((r) => setTimeout(r, 100))

      const resetPromise = resetTenant(admin, { slug: SLUG, confirm: SLUG, operator: 'blocked-by-held-lock' })
        .finally(() => { settled = true })
      resetPromise.catch(() => {}) // observed below (or not, on the assertion-failure path) — never unhandled

      await new Promise((r) => setTimeout(r, 300))
      expect(settled, 'resetTenant must still be blocked on the held per-tenant lock — this is what fails (settles immediately) with the lock line removed').toBe(false)

      releaseHolder()
      await holderTx
      const result = await resetPromise
      expect(settled).toBe(true)
      expect(result.manifestId).toBeDefined()
    } finally {
      releaseHolder() // idempotent — resolving an already-resolved promise is a no-op
      await holderTx.catch(() => {})
      await holder.end()
    }
  })
})

// ADR-253 §3.1/§3.3/§3.4/§3.4a: which store, measured — the pure name-search rule, the witness
// table's real behaviour (through the same bare pool resolution itself uses), and the orchestrator
// driven by a fake OpenFgaClient so the decision flow is exercised without a live multi-store FGA.
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { FgaApiNotFoundError, type OpenFgaClient } from '@openfga/sdk'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import {
  searchByName,
  storeExists,
  readWitness,
  writeWitness,
  rebindWitness,
  forgetWitness,
  resolveStoreBinding,
  resolveStoreBindingLocked,
  STORE_NAME,
  type FgaStoreSummary,
} from '../openfga-resolve.js'

// DROP/re-CREATE TABLE requires the admin role — the runtime `pool` is NOSUPERUSER and cannot (by
// design; see db/pool.ts's own header). Used only by the §3.4a test below.
const admin = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
afterAll(async () => { await admin.end() })

afterEach(async () => {
  await pool`DELETE FROM openfga_store_binding`.catch(() => {})
})

describe('ADR-253 §3.3 searchByName', () => {
  const stores: FgaStoreSummary[] = [
    { id: 'a', name: STORE_NAME },
    { id: 'b', name: 'something-else' },
  ]

  it('exactly one match → found', () => {
    expect(searchByName(stores, STORE_NAME)).toEqual({ kind: 'found', storeId: 'a' })
  })

  it('no match → none', () => {
    expect(searchByName(stores, 'nothing-named-this')).toEqual({ kind: 'none' })
  })

  it('more than one match → ambiguous, naming every id — never "the newest"', () => {
    const twoNamedTheSame: FgaStoreSummary[] = [...stores, { id: 'c', name: STORE_NAME }]
    const out = searchByName(twoNamedTheSame, STORE_NAME)
    expect(out.kind).toBe('ambiguous')
    expect((out as { ids: string[] }).ids.sort()).toEqual(['a', 'c'])
  })
})

// A fake narrow enough to drive resolveStoreBinding's decision flow, not the real HTTP client. The
// unambiguous single-page listing shape is asserted separately in listAllStores (not exercised
// against a live multi-store FGA here — that would require creating real duplicate stores).
function fakeFga(opts: { stores: FgaStoreSummary[]; live: Set<string> }): OpenFgaClient {
  return {
    listStores: async () => ({ stores: opts.stores, continuation_token: '' }),
    getStore: async ({ storeId }: { storeId: string }) => {
      if (!opts.live.has(storeId)) throw new FgaApiNotFoundError({} as never)
      return { id: storeId, name: STORE_NAME, created_at: '', updated_at: '' }
    },
  } as unknown as OpenFgaClient
}

describe('ADR-253 §3.4a the witness table missing is a distinct wait, not a refusal', () => {
  it("resolveStoreBinding answers 'wait-for-migration' before the table exists", async () => {
    await admin`DROP TABLE IF EXISTS openfga_store_binding`
    try {
      const out = await resolveStoreBinding({
        fga: fakeFga({ stores: [], live: new Set() }),
        sql: pool,
        explicitStoreId: undefined,
      })
      expect(out).toEqual({ kind: 'wait-for-migration' })
    } finally {
      // Restore for every other test in this file and in the suite — the migration itself is
      // idempotent (CREATE TABLE IF NOT EXISTS).
      const { readFileSync } = await import('node:fs')
      const { join, resolve } = await import('node:path')
      const root = resolve(import.meta.dirname, '../../../..')
      const sql = readFileSync(join(root, 'infra/db/migrations/128_openfga_store_binding.sql'), 'utf8')
      await admin.unsafe(sql)
    }
  })
})

describe('ADR-253 §3.1/§3.4 resolveStoreBinding, driven end to end against the real witness table', () => {
  it('absent witness, no explicit id, no store found by name → create', async () => {
    const out = await resolveStoreBinding({
      fga: fakeFga({ stores: [], live: new Set() }),
      sql: pool,
      explicitStoreId: undefined,
    })
    expect(out).toEqual({ kind: 'create' })
  })

  it('absent witness, a live store found by name → bound, and the witness is written', async () => {
    const out = await resolveStoreBinding({
      fga: fakeFga({ stores: [{ id: 'store-1', name: STORE_NAME }], live: new Set(['store-1']) }),
      sql: pool,
      explicitStoreId: undefined,
    })
    expect(out).toEqual({ kind: 'bound', storeId: 'store-1', created: false })
    const witness = await readWitness(pool)
    expect(witness).toEqual({ kind: 'row', witness: { storeId: 'store-1' } })
  })

  it('explicit id always wins — no listing, even with a different store discoverable by name', async () => {
    const out = await resolveStoreBinding({
      fga: fakeFga({ stores: [{ id: 'store-by-name', name: STORE_NAME }], live: new Set(['store-explicit', 'store-by-name']) }),
      sql: pool,
      explicitStoreId: 'store-explicit',
    })
    expect(out).toEqual({ kind: 'bound', storeId: 'store-explicit', created: false })
  })

  it('more than one store named "wikistead" → refuse, naming both, and the witness is untouched', async () => {
    const out = await resolveStoreBinding({
      fga: fakeFga({
        stores: [{ id: 'x', name: STORE_NAME }, { id: 'y', name: STORE_NAME }],
        live: new Set(['x', 'y']),
      }),
      sql: pool,
      explicitStoreId: undefined,
    })
    expect(out.kind).toBe('refuse')
    expect((out as { message: string }).message).toMatch(/x/)
    expect((out as { message: string }).message).toMatch(/y/)
    expect(await readWitness(pool)).toEqual({ kind: 'row', witness: null })
  })

  it('witness bound to a store that is gone → refuse, and does not silently create a new one', async () => {
    await writeWitness(pool, 'store-lost')
    const out = await resolveStoreBinding({
      fga: fakeFga({ stores: [], live: new Set() }),
      sql: pool,
      explicitStoreId: undefined,
    })
    expect(out.kind).toBe('refuse')
    expect((out as { message: string }).message).toMatch(/store-lost/)
  })

  it('witness bound, and this boot would use the same live store → bound, nothing rewritten', async () => {
    await writeWitness(pool, 'store-steady')
    const out = await resolveStoreBinding({
      fga: fakeFga({ stores: [{ id: 'store-steady', name: STORE_NAME }], live: new Set(['store-steady']) }),
      sql: pool,
      explicitStoreId: undefined,
    })
    expect(out).toEqual({ kind: 'bound', storeId: 'store-steady', created: false })
  })
})

describe('ADR-253 §8② forgetWitness and the rotate path rebindWitness', () => {
  it('rebindWitness moves the binding (rotate), forgetWitness removes it (the recovery command)', async () => {
    await writeWitness(pool, 'store-original')
    await rebindWitness(pool, 'store-rotated')
    expect(await readWitness(pool)).toEqual({ kind: 'row', witness: { storeId: 'store-rotated' } })

    await forgetWitness(pool)
    expect(await readWitness(pool)).toEqual({ kind: 'row', witness: null })
  })
})

describe('storeExists', () => {
  it('true when getStore answers, false on a 404, and rethrows anything else', async () => {
    const live = fakeFga({ stores: [], live: new Set(['a']) })
    expect(await storeExists(live, 'a')).toBe(true)
    expect(await storeExists(live, 'b')).toBe(false)

    const broken = { getStore: async () => { throw new Error('network down') } } as unknown as OpenFgaClient
    await expect(storeExists(broken, 'a')).rejects.toThrow('network down')
  })
})

describe('ADR-253 §3.6 concurrent resolution produces one store', () => {
  // The SHIPPED resolveStoreBindingLocked, called N times in parallel on SEPARATE connections (the
  // real failure shape — two processes, not two calls sharing one client) — not "start three
  // processes and look". Each call starts with no store discoverable by name, so absent the lock
  // every one of them would independently decide 'create'.
  it('N callers racing from empty resolve to exactly one created store', async () => {
    let createCalls = 0
    const stores: FgaStoreSummary[] = []
    const live = new Set<string>()
    const racer = {
      listStores: async () => ({ stores: [...stores], continuation_token: '' }),
      getStore: async ({ storeId }: { storeId: string }) => {
        if (!live.has(storeId)) throw new FgaApiNotFoundError({} as never)
        return { id: storeId, name: STORE_NAME, created_at: '', updated_at: '' }
      },
      createStore: async () => {
        createCalls++
        // A slow create is where an unlocked race actually shows itself — two callers both past
        // the "nothing found" read before either writes back.
        await new Promise((r) => setTimeout(r, 20))
        const id = `store-race-${createCalls}`
        stores.push({ id, name: STORE_NAME })
        live.add(id)
        return { id }
      },
    } as unknown as OpenFgaClient

    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveStoreBindingLocked(pool, racer, undefined)),
    )

    expect(createCalls, 'the lock did not serialize creation — more than one caller created a store').toBe(1)
    const boundIds = new Set(results.map((r) => (r.kind === 'bound' ? r.storeId : r)))
    expect(boundIds.size, `all callers must land on the same store: ${JSON.stringify(results)}`).toBe(1)
    expect(await readWitness(pool)).toEqual({ kind: 'row', witness: { storeId: [...boundIds][0] } })
  })

  // Break-check for the test above: with the lock statement removed, this same race is expected to
  // create more than one store — proving the test can tell the difference, not just that it passes.
  it('…and removing the lock is what the test above exists to catch (unlocked control)', async () => {
    let createCalls = 0
    const stores: FgaStoreSummary[] = []
    const live = new Set<string>()
    const racer = {
      listStores: async () => ({ stores: [...stores], continuation_token: '' }),
      getStore: async ({ storeId }: { storeId: string }) => {
        if (!live.has(storeId)) throw new FgaApiNotFoundError({} as never)
        return { id: storeId, name: STORE_NAME, created_at: '', updated_at: '' }
      },
      createStore: async () => {
        createCalls++
        await new Promise((r) => setTimeout(r, 20))
        const id = `store-unlocked-race-${createCalls}`
        stores.push({ id, name: STORE_NAME })
        live.add(id)
        return { id }
      },
    } as unknown as OpenFgaClient

    // Calls resolveStoreBinding directly — the unlocked function — five times in parallel, each on
    // its own read-then-decide-then-act, exactly what resolveStoreBindingLocked's lock prevents.
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const result = await resolveStoreBinding({ fga: racer, sql: pool, explicitStoreId: undefined })
        if (result.kind === 'create') {
          const { id } = await racer.createStore({ name: STORE_NAME } as never)
          await writeWitness(pool, id).catch(() => {}) // the second writer's INSERT conflicts; expected
        }
      }),
    )
    expect(createCalls, 'the unlocked control did not race — widen the artificial delay above').toBeGreaterThan(1)
  })
})

// #710: the roster walk is split — listing pages, ids RESOLVE. These pins hold the resolver's
// authz face (uniform null: denied ≡ nonexistent, per id, in one batch, answered 200 — never a
// partial that treats the two differently) and the name-ordered keyset walk (#287 server-side),
// including the cursor's binding to the order that minted it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { buildApp } from '../app.js'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
let app: Awaited<ReturnType<typeof buildApp>>
let t: PrivateTenant

const mk = async (name: string) => {
  const r = await app.inject({ method: 'POST', url: '/spaces', headers: t.H, payload: { name } })
  expect(r.statusCode).toBe(201)
  return r.json().id as string
}
const uid = () => crypto.randomUUID().slice(0, 8)

beforeAll(async () => {
  app = await buildApp()
  t = await privateTenant(adminPool, 't710')
}, 120_000)
afterAll(async () => {
  await adminPool`DELETE FROM spaces WHERE tenant_id = ${t.id}`.catch(() => {})
  await t?.dispose()
  await app?.close()
  await adminPool.end()
})

describe('#710 A: POST /spaces/resolve', () => {
  it('answers every requested id; a nonexistent id and an invisible id are byte-identical nulls (200, never a differential)', async () => {
    const mine = await mk(`resolve-mine-${uid()}`)
    // An EXISTING space of this tenant the caller has no FGA path to: row only, no tuples — the
    // "created by someone else, never shared" shape.
    const invisible = crypto.randomUUID()
    await adminPool`INSERT INTO spaces (id, tenant_id, name) VALUES (${invisible}, ${t.id}, 'r710-invisible')`
    const ghost = crypto.randomUUID() // never created anywhere
    const r = await app.inject({
      method: 'POST', url: '/spaces/resolve', headers: t.H,
      payload: { ids: [mine, invisible, ghost] },
    })
    expect(r.statusCode).toBe(200)
    const spaces = r.json().spaces as Record<string, unknown>
    expect(Object.keys(spaces).sort()).toEqual([mine, invisible, ghost].sort()) // every id answers
    const resolved = spaces[mine] as { id: string; capability: string; deleteMode: string }
    expect(resolved.id).toBe(mine)
    expect(resolved.capability).toBe('manage') // creator manages
    expect(resolved.deleteMode).toBeTruthy() // ADR-167 policy rides the resolver like the listing
    // The oracle pin: denied and nonexistent are the SAME value — the response reveals nothing
    // about whether an id names a real space.
    expect(spaces[invisible]).toBeNull()
    expect(spaces[ghost]).toBeNull()
    expect(JSON.stringify(spaces[invisible])).toBe(JSON.stringify(spaces[ghost]))
  })

  it("a cross-tenant id resolves null too (RLS keeps the row out before FGA is even asked)", async () => {
    const other = await privateTenant(adminPool, 't710x')
    const foreign = crypto.randomUUID()
    await adminPool`INSERT INTO spaces (id, tenant_id, name) VALUES (${foreign}, ${other.id}, 'r710-foreign')`
    const r = await app.inject({ method: 'POST', url: '/spaces/resolve', headers: t.H, payload: { ids: [foreign] } })
    expect(r.statusCode).toBe(200)
    expect(r.json().spaces[foreign]).toBeNull()
    await adminPool`DELETE FROM spaces WHERE tenant_id = ${other.id}`.catch(() => {})
    await other.dispose()
  })

  it('refuses a shapeless request (no ids / empty / over the cap) with 400, resolving nothing', async () => {
    for (const payload of [{}, { ids: [] }, { ids: Array.from({ length: 101 }, () => crypto.randomUUID()) }]) {
      const r = await app.inject({ method: 'POST', url: '/spaces/resolve', headers: t.H, payload })
      expect(r.statusCode).toBe(400)
    }
  })
})

describe('#710 C: order=name keyset walk', () => {
  it('walks name order across page boundaries without repeating or dropping (keyset (lower(name), id))', async () => {
    const tag = `nm${uid()}`
    const names = ['delta', 'Alpha', 'charlie', 'Bravo', 'echo'].map((n) => `${tag}-${n}`)
    for (const n of names) await mk(n)
    const collect: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const url: string = `/spaces?order=name&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const r = await app.inject({ method: 'GET', url, headers: t.H })
      expect(r.statusCode).toBe(200)
      const page = r.json() as { spaces: { name: string }[]; nextCursor: string | null; restarted?: boolean }
      expect(page.restarted).toBeUndefined() // a same-order cursor never restarts
      collect.push(...page.spaces.map((s) => s.name).filter((n) => n.startsWith(tag)))
      cursor = page.nextCursor
      pages += 1
      expect(pages).toBeLessThan(50) // the walk terminates
    } while (cursor)
    // case-insensitive name order (lower(name) is the key), complete, no repeats
    expect(collect).toEqual([...names].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1))
  })

  it('a cursor minted under one order restarts the other walk instead of resuming it (order-bound cursor)', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/spaces?limit=1', headers: t.H })
    const created = r1.json() as { nextCursor: string | null }
    expect(created.nextCursor).not.toBeNull()
    const r2 = await app.inject({
      method: 'GET', url: `/spaces?order=name&limit=1&cursor=${encodeURIComponent(created.nextCursor!)}`, headers: t.H,
    })
    expect(r2.statusCode).toBe(200)
    expect((r2.json() as { restarted?: boolean }).restarted).toBe(true)
    // and the reverse: a name cursor fed to the created walk restarts too
    const n1 = await app.inject({ method: 'GET', url: '/spaces?order=name&limit=1', headers: t.H })
    const nameCursor = (n1.json() as { nextCursor: string | null }).nextCursor
    expect(nameCursor).not.toBeNull()
    const r3 = await app.inject({ method: 'GET', url: `/spaces?limit=1&cursor=${encodeURIComponent(nameCursor!)}`, headers: t.H })
    expect((r3.json() as { restarted?: boolean }).restarted).toBe(true)
  })
})

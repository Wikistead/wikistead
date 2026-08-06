// #655 / ADR-219 §2: a session records which door it came through, and nothing reads it yet.
//
// The value set is four doors rather than a satisfied/not boolean, and that is the decision being
// pinned. Two values cannot say "federated logins are out of scope" — an implementer reading
// `satisfied: false` about an OIDC session would send it to an interstitial and reverse the ruling
// without editing it. Naming the door keeps "not asked" and "asked and unanswered" apart.
//
// The other half is the absent value. A session written before this field reads as `local`, the
// unsatisfied end, so holding an old cookie is not a way around a requirement introduced later.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import IORedis from 'ioredis'
import { createSession, readSession, doorOf, type SessionData } from '../auth/session.js'

const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const T = 'tenant_dev'
const STAMP = Date.now().toString(36)

beforeAll(async () => { /* valkey connects lazily */ })
afterAll(async () => { await valkey.quit() })

describe('#655: the door is recorded', () => {
  it('round-trips every door in the set', async () => {
    for (const door of ['local', 'local+factor', 'federated', 'operator'] as const) {
      const sid = await createSession(valkey, { tenantId: T, sub: `door655-${door}-${STAMP}`, door })
      const s = await readSession(valkey, sid)
      expect(s, `${door} session exists`).toBeTruthy()
      expect(doorOf(s as SessionData), `${door} survives the round trip`).toBe(door)
      await valkey.del(`sess:${sid}`)
    }
  }, 60_000)

  it('a session written before the field reads as local, not as anything satisfied', async () => {
    // Written by hand in the shape the old code produced — no `door` key at all. Grandfathering this
    // to "already fine" would make an old cookie the way around a requirement added later.
    const sid = `door655-legacy-${STAMP}`
    const now = Date.now()
    await valkey.set(`sess:${sid}`, JSON.stringify({
      tenantId: T, sub: 'door655-legacy', email: null, role: 'member', groups: [],
      createdAt: now, absExpiry: now + 86_400_000,
    }), 'EX', 300)
    const s = await readSession(valkey, sid)
    expect(s, 'the old session still loads').toBeTruthy()
    expect((s as SessionData).door, 'and it carries no door of its own').toBeUndefined()
    expect(doorOf(s as SessionData), 'read as the unsatisfied end').toBe('local')
    await valkey.del(`sess:${sid}`)
  }, 60_000)
})

describe('#655: every path that opens a session says which door it opened', () => {
  // A scan rather than five assertions about five files: the count is what the ticket names, and a
  // sixth path added next month is exactly the case a list of five cannot catch. Includes
  // `packages/ee-server` — the SAML caller lives in another package and is the one a sweep of
  // `apps/server` alone would miss.
  const ROOTS = [
    resolve(import.meta.dirname, '../..', 'src'),
    resolve(import.meta.dirname, '../../../..', 'packages/ee-server/src'),
  ]
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(resolve(dir, e.name)) : /\.ts$/.test(e.name) ? [resolve(dir, e.name)] : [])

  it('names a door at every product call site', () => {
    const unnamed: string[] = []
    let sites = 0
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (/__tests__|\.test\.ts$/.test(file)) continue
        const src = readFileSync(file, 'utf8')
        // The call spans lines at some sites, so the window is the call and what follows it up to the
        // closing paren — matching on one line would report the multi-line callers as unnamed.
        for (const m of src.matchAll(/establishMemberSession\(/g)) {
          // Skip the DEFINITION: `export async function establishMemberSession(` matches the same
          // text, and counting it reported the file that provides the parameter as a caller that
          // forgot to pass it.
          if (/function\s+$/.test(src.slice(Math.max(0, m.index! - 40), m.index!))) continue
          sites += 1
          const window = src.slice(m.index!, m.index! + 600)
          if (!/door:\s*'(local|local\+factor|federated|operator)'/.test(window)) {
            unnamed.push(`${file.split('/').slice(-2).join('/')} @${m.index}`)
          }
        }
      }
    }
    expect(sites, 'the scan found the call sites at all').toBeGreaterThanOrEqual(5)
    expect(unnamed, 'these open a session without saying which door').toEqual([])
  })

  it('nothing enforces it yet — this slice lands inert', () => {
    // The ticket asks for the field and only the field. A `doorOf` consulted by a guard in the same
    // commit would change the value's meaning and the refusal behaviour at once, which is the one
    // thing this slice was split out to avoid.
    const readers: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (/__tests__|\.test\.ts$/.test(file) || /auth\/session\.ts$/.test(file)) continue
        if (/\bdoorOf\s*\(/.test(readFileSync(file, 'utf8'))) readers.push(file.split('/').slice(-2).join('/'))
      }
    }
    expect(readers, 'something already reads the door — enforcement belongs to its own slice').toEqual([])
  })
})

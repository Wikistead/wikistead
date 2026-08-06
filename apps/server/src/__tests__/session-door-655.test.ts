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

  // Which door each path is expected to name. The scan alone answered "some door" and stayed green
  // when SAML claimed `local` — measured by the review, and it is the exact failure this ticket
  // named: a federated member would be sent to an interstitial that ADR-219 §3 says they must never
  // see, and could never satisfy. The scan stays, because it is what catches a SIXTH path; the table
  // is what catches a path naming the wrong thing.
  const EXPECTED: { file: RegExp; doors: string[] }[] = [
    { file: /routes\/auth\.ts$/, doors: ['federated'] },                 // OIDC callback
    { file: /saml\/saml-auth\.ts$/, doors: ['federated'] },              // SAML, in the other package
    { file: /routes\/auth-local\.ts$/, doors: ['local', 'operator'] },   // password, and break-glass acceptance
  ]

  it('names a door at every product call site', () => {
    const unnamed: string[] = []
    let sites = 0
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (/__tests__|\.test\.ts$/.test(file)) continue
        const src = readFileSync(file, 'utf8')
        // The call spans lines at some sites, so the window is the call and a generous slice after it.
        // Generous on purpose: these call sites carry the comment explaining WHICH door they name, and
        // a 600-character window ended inside that comment and reported the caller as unnamed.
        for (const m of src.matchAll(/establishMemberSession\(/g)) {
          // Skip the DEFINITION: `export async function establishMemberSession(` matches the same
          // text, and counting it reported the file that provides the parameter as a caller that
          // forgot to pass it.
          if (/function\s+$/.test(src.slice(Math.max(0, m.index! - 40), m.index!))) continue
          sites += 1
          const window = src.slice(m.index!, m.index! + 1400)
          // Matched through an expression, not only a literal: the invite path chooses between two
          // doors on the spot, and a pattern that only read `door: 'x'` called it unnamed.
          if (!/door:[^,)}]*'(local\+factor|local|federated|operator)'/.test(window)) {
            unnamed.push(`${file.split('/').slice(-2).join('/')} @${m.index}`)
          }
        }
      }
    }
    expect(sites, 'the scan found the call sites at all').toBeGreaterThanOrEqual(5)
    expect(unnamed, 'these open a session without saying which door').toEqual([])
  })

  it('names the RIGHT door — a federated path may not claim a local one', () => {
    const wrong: string[] = []
    for (const rule of EXPECTED) {
      const files = ROOTS.flatMap(walk).filter((f) => rule.file.test(f) && !/__tests__|\.test\.ts$/.test(f))
      expect(files.length, `the path this rule is about still exists :: ${rule.file}`).toBeGreaterThan(0)
      for (const file of files) {
        const src = readFileSync(file, 'utf8')
        for (const m of src.matchAll(/establishMemberSession\(/g)) {
          if (/function\s+$/.test(src.slice(Math.max(0, m.index! - 40), m.index!))) continue
          const window = src.slice(m.index!, m.index! + 1400)
          const named = [...window.matchAll(/door:[^,)}]*'(local\+factor|local|federated|operator)'/g)].map((d) => d[1]!)
          const off = named.filter((d) => !rule.doors.includes(d))
          if (off.length) wrong.push(`${file.split('/').slice(-2).join('/')} says ${off.join(',')} — expected ${rule.doors.join(' or ')}`)
        }
      }
    }
    expect(wrong, 'a path is naming a door that is not its own').toEqual([])
  })

  it('the break-glass acceptance can reach `operator` at all', () => {
    // The reject found `operator` existing only in the type. A door nothing can write is a value the
    // enforcement slice will read as impossible, and the break-glass invite — the way back in when
    // every other entrance is shut (#616) — would be sent to the interstitial it exists to bypass.
    const src = ROOTS.flatMap(walk).filter((f) => /routes\/auth-local\.ts$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(/door:[^,)}]*'operator'/.test(src), 'nothing writes the operator door').toBe(true)
  })

  it('the door is read in ONE place, and that place decides nothing by itself', () => {
    // This began as "nothing enforces it yet — this slice lands inert", which was right for #655: a
    // `doorOf` consulted by a guard in the same commit would have changed the value's meaning and the
    // refusal behaviour at once, and splitting them is exactly what that slice was for.
    //
    // #652 slice 1 landed the first reader, so the assertion has been narrowed rather than deleted —
    // deleting it would give up the property it was protecting. What it protects now is that the door
    // is interpreted in ONE place (`factor-policy.ts`, a pure table with no request, no database and no
    // refusal in it). A second reader would be a second interpretation, which is how "federated is out
    // of scope" gets quietly reversed in one call site while the ADR still says otherwise.
    const readers: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (/__tests__|\.test\.ts$/.test(file) || /auth\/session\.ts$/.test(file)) continue
        if (/\bdoorOf\s*\(/.test(readFileSync(file, 'utf8'))) readers.push(file.split('/').slice(-2).join('/'))
      }
    }
    // The walk must be able to SEE a reader, or this passes on a broken walk saying nothing at all.
    expect(readers.length, 'the walk found the one reader it expects').toBe(1)
    expect(readers, 'the door has more than one interpreter (#652: keep the table in factor-policy.ts)')
      .toEqual(['auth/factor-policy.ts'])
  })
})

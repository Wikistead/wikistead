import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  runInAuthzScope, openAuthzScope, setAuthzRestriction, currentAuthzScope,
  requireAuthzScope, resetAuthzScopeRequirement, authzScopeForCheck, SYSTEM_SCOPE,
} from '@wikistead/authz'

// #637 / ADR-216 §1-2: the mechanism that carries a per-request authorization restriction, and the
// declaration that makes forgetting it a crash instead of a widening.
//
// What is worth measuring here is not "the storage stores things" — that is Node's job — but the three
// properties the design rests on: concurrent requests do not see each other's restriction; a process
// that declared the requirement refuses a check outside a scope; and a process that did not declare it
// is untouched, because collab and the CLI share this code and serve no request path.
afterEach(() => resetAuthzScopeRequirement())

describe('#637: the scope reaches what the request awaits', () => {
  it('two overlapping requests do not see each other', async () => {
    // The failure this rules out is the one that matters: a restriction leaking from one request into
    // another is a key reaching a space it was confined out of. Interleaved on purpose — sequential
    // calls would pass with a single global variable.
    const seen: (string | null)[] = []
    const one = runInAuthzScope({ restriction: { spaces: new Set(['s1']) } }, async () => {
      await new Promise((r) => setTimeout(r, 20))
      seen.push([...(currentAuthzScope()?.restriction?.spaces ?? [])].join() || null)
    })
    const two = runInAuthzScope({ restriction: { spaces: new Set(['s2']) } }, async () => {
      await new Promise((r) => setTimeout(r, 5))
      seen.push([...(currentAuthzScope()?.restriction?.spaces ?? [])].join() || null)
    })
    await Promise.all([one, two])
    expect(seen.sort(), 'each kept its own').toEqual(['s1', 's2'])
    expect(currentAuthzScope(), 'and neither escaped').toBeNull()
  })

  it('the container opens empty and authentication fills it in', () => {
    // The request path cannot know the restriction when the scope opens — working it out means reading
    // the database, which has to happen INSIDE. So the outermost hook opens an empty one.
    let inside: ReturnType<typeof currentAuthzScope> = null
    openAuthzScope(() => {
      expect(currentAuthzScope()?.restriction, 'nothing known yet').toBeNull()
      setAuthzRestriction({ spaces: new Set(['s9']) })
      inside = currentAuthzScope()
    })
    expect([...(inside!.restriction?.spaces ?? [])]).toEqual(['s9'])
  })

  it('filling one in from outside is an error, not a no-op', () => {
    // Dropping the restriction on the floor is the fail-open this whole mechanism exists to prevent, so
    // a hook order that puts authentication outside the container has to say so.
    expect(() => setAuthzRestriction({ spaces: new Set(['s1']) })).toThrow(/outside an authorization scope/)
  })
})

describe('#637: a process that declared the requirement crashes rather than opens', () => {
  it('a check outside a scope throws once declared', () => {
    expect(authzScopeForCheck(), 'undeclared: unrestricted, as it always was').toBe(SYSTEM_SCOPE)
    requireAuthzScope()
    expect(() => authzScopeForCheck()).toThrow(/outside an authorization scope/)
  })

  it('…and is satisfied by any scope, including the system one', () => {
    requireAuthzScope()
    runInAuthzScope(SYSTEM_SCOPE, () => {
      expect(authzScopeForCheck().restriction, 'work that is nobody\'s request is unrestricted — and says so').toBeNull()
    })
    openAuthzScope(() => { expect(() => authzScopeForCheck()).not.toThrow() })
  })

  it('collab and the CLI are untouched, because they never declare it', () => {
    // They import the same primitives. If the declaration lived in `buildApp` (or in the module itself)
    // they would throw for a rule about a request path they do not serve.
    expect(() => authzScopeForCheck()).not.toThrow()
    expect(authzScopeForCheck().restriction).toBeNull()
  })
})

describe('#637: the declaration is made where requests are served, and nowhere else', () => {
  const SRC = resolve(import.meta.dirname, '..')

  it('the CE entrypoint declares it; buildApp does not', () => {
    expect(readFileSync(resolve(SRC, 'index.ts'), 'utf8'), 'the serving entrypoint').toMatch(/requireAuthzScope\(\)/)
    // In `buildApp` it would reach the test harness and the collab process, which build an app and serve
    // no requests — they would throw for a rule that does not apply to them.
    const app = readFileSync(resolve(SRC, 'app.ts'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n')
    expect(app, 'and not in buildApp').not.toMatch(/requireAuthzScope\(\)/)
    expect(app, 'which does open the container, at the outermost hook').toMatch(/openAuthzScope\(done\)/)
  })

  it('every interval sweep says it is unrestricted rather than arriving with nothing', () => {
    // Discovery rather than a list of five: any file that starts a repeating timer AND reaches an
    // authorization primitive has to name its scope. A sixth sweep written next month is covered by
    // existing, and one that forgets crashes in production rather than here — which is why this asks.
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(resolve(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [resolve(dir, e.name)] : [])
    const missing: string[] = []
    let looked = 0
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8')
      if (!/setInterval\(/.test(src)) continue
      // does it reach authorization at all? a timer that only touches SQL needs no scope
      if (!/\bcheck\(|filterAuthorized\(|checkRelation\(|checkMemberAccess\(|drain\(/.test(src)) continue
      looked++
      if (!/runInAuthzScope\(/.test(src)) missing.push(file.slice(SRC.length + 1))
    }
    expect(looked, 'the walk found timers that reach authorization (else this measures nothing)').toBeGreaterThan(3)
    expect(missing, `a repeating sweep reaches authorization with no scope named :: ${missing.join(', ')}`).toEqual([])
  })
})

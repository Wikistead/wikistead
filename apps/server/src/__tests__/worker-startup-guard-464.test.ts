// #464 the analytics drain worker existed, was fully tested — and was never started. Every
// test called the drain function directly, so the suite stayed green while production folded nothing:
// the roster would have been empty for ever and the outbox grown unboundedly. The same class threat
// applies to every background worker: a module can ship its start*Worker and nobody wires it.
//
// This is the structural guard (the #479 bare-pool-rls-guard pattern — a cheap source scan, red the
// day someone adds a worker without starting it): every `start*Worker` exported anywhere under
// apps/server/src must be INVOKED from server.ts (startServer is the one place background timers
// belong — buildApp stays timer-free so inject-driven tests don't spawn them).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dirname, '..')

// The generic lease runner (db/outbox-lease.ts) is the PRIMITIVE the concrete workers are built on —
// it is started via them, never directly from server.ts.
const PRIMITIVES = new Set(['startOutboxDrainWorker'])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (e === '__tests__' || e === 'node_modules' || e === 'dist') continue
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts')) out.push(p)
    }
  }
  walk(dir)
  return out
}

describe('worker startup guard (#464)', () => {
  it('every exported start*Worker is invoked from server.ts', () => {
    const workers = new Map<string, string>() // name → defining file
    for (const f of sourceFiles(SRC)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/export (?:function|const) (start\w*Worker)\b/g)) {
        if (!PRIMITIVES.has(m[1]!)) workers.set(m[1]!, f)
      }
    }
    expect(workers.size, 'the scan finds the known workers (a broken scan must not pass vacuously)').toBeGreaterThanOrEqual(6)

    const serverTs = readFileSync(join(SRC, 'server.ts'), 'utf8')
    const missing = [...workers.entries()].filter(([name]) => !new RegExp(`\\b${name}\\s*\\(`).test(serverTs))
    expect(
      missing.map(([name, file]) => `${name} (${file}) is exported but never started from server.ts`),
      'a worker that is never started folds nothing in production — wire it in startServer',
    ).toEqual([])
  })
})

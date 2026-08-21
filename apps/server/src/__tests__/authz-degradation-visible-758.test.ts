// #758 / ADR-183 §3. The ADR's own default proposal was "accept for v1 … log a warn per degraded
// batch". The first half shipped and the second half did not, so for months a saturated store could
// quietly remove rows from somebody's sidebar and leave no evidence anywhere that it had.
//
// The silence is the point. When the store thins a list, the result is INDISTINGUISHABLE from the
// truth: a page the reader may not see and a page the store could not answer for both arrive as
// absence. There is no error, no status, no gap in the numbering. "A page disappeared from my sidebar"
// had, before this, nothing that could confirm or refute it.
//
// What must stay true while making it visible: the observation cannot become the outcome. Every test
// below that asserts a log also asserts the verdicts did not move.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import type { FastifyInstance } from 'fastify'
import {
  filterAuthorized, registerAuthzDegradationSink, resetAuthzDegradationSink, hasAuthzDegradationSink,
  type AuthzDegradation,
} from '@wikistead/authz'
import { buildApp } from '../app.js'

// A store that answers cleanly for some ids and errors on others — the shape a saturated OpenFGA
// returns, and the one whose verdicts get thinned.
function store(errorFor: (id: string) => boolean, allow: (id: string) => boolean = () => true, dropFor: (id: string) => boolean = () => false) {
  return {
    batchCheck: async (body: { checks: { object: string; correlationId?: string }[] }) => ({
      // #816: `dropFor` omits the entry entirely — the store never spoke about that id, which is a
      // different shape from an entry carrying an error and produces no error text of its own.
      result: body.checks.flatMap((c) => {
        const id = c.object.replace(/^[a-z_]+:/, '')
        if (dropFor(id)) return []
        return [errorFor(id)
          ? {
              allowed: false, request: c, correlationId: c.correlationId!,
              error: { internal_error: 'deadline_exceeded', message: 'context deadline exceeded' },
            }
          : { allowed: allow(id), request: c, correlationId: c.correlationId! }]
      }),
    }),
  } as unknown as OpenFgaClient
}

const ids = (n: number, p = 'p') => Array.from({ length: n }, (_, i) => `${p}${i}`)

afterEach(() => resetAuthzDegradationSink())

describe('#758: a thinned batch is reported', () => {
  it('names how many ids the store could not answer, and what it said', async () => {
    const seen: AuthzDegradation[] = []
    registerAuthzDegradationSink((d) => seen.push(d))

    const out = await filterAuthorized(store((id) => Number(id.slice(1)) < 3), 'user:u', 'view', ids(10))

    expect(seen).toHaveLength(1)
    expect(seen[0].unanswered, 'the count of lost verdicts').toBe(3)
    expect(seen[0].candidates, 'the size of the batch it happened in').toBe(10)
    expect(seen[0].relation).toBe('view')
    expect(seen[0].resourceType).toBe('page')
    expect(seen[0].firstError, 'the store gets to say why in its own words').toMatch(/deadline_exceeded/)
    // …and the answer is the one ADR-183 §3 ruled: the three that errored are denied, not the batch.
    expect(out).toEqual(new Set(ids(10).filter((id) => Number(id.slice(1)) >= 3)))
  })

  // #816: the same loss, arriving as SILENCE rather than as an error. An id the store never spoke about
  // was invisible to this report, because the count was a tally of bad answers rather than the ids that
  // never got one — so the operator saw nothing at all where a reader had lost rows.
  it('counts the ids the store never spoke about, not just the ones it errored on', async () => {
    const seen: AuthzDegradation[] = []
    registerAuthzDegradationSink((d) => seen.push(d))

    const out = await filterAuthorized(
      store(() => false, () => true, (id) => Number(id.slice(1)) < 3), 'user:u', 'view', ids(10))

    expect(seen, 'a batch that lost three verdicts to silence reported nothing').toHaveLength(1)
    expect(seen[0].unanswered, 'the count of lost verdicts').toBe(3)
    expect(seen[0].candidates).toBe(10)
    expect(seen[0].firstError, 'no entry means no words of the store\'s own — say so rather than nothing')
      .toMatch(/no entry/)
    // The verdicts do not move: fail-closed for the three, answered for the rest (ADR-183 §3).
    expect(out).toEqual(new Set(ids(10).filter((id) => Number(id.slice(1)) >= 3)))
  })

  it('says nothing when nothing was lost — a warn on every healthy read teaches operators to ignore it', async () => {
    const seen: AuthzDegradation[] = []
    registerAuthzDegradationSink((d) => seen.push(d))
    await filterAuthorized(store(() => false), 'user:u', 'view', ids(10))
    expect(seen, 'a clean batch reported itself as degraded').toEqual([])
  })

  it('reports once per batch, so a big list does not become a wall of identical lines', async () => {
    // 120 ids at 50 = three chunks; the middle one is the only one that loses anything.
    const seen: AuthzDegradation[] = []
    registerAuthzDegradationSink((d) => seen.push(d))
    await filterAuthorized(store((id) => { const n = Number(id.slice(1)); return n >= 50 && n < 55 }), 'user:u', 'view', ids(120))
    expect(seen).toHaveLength(1)
    expect(seen[0].unanswered).toBe(5)
    expect(seen[0].candidates, 'the chunk it happened in, not the whole call').toBe(50)
  })
})

describe('#758: the observation cannot become the outcome', () => {
  it('the verdicts are byte-identical with and without a sink', async () => {
    // The break-check for the whole change: if any of this reached the answer, these two differ.
    const errored = (id: string) => Number(id.slice(1)) % 4 === 0
    const allow = (id: string) => Number(id.slice(1)) % 3 !== 0

    const silent = await filterAuthorized(store(errored, allow), 'user:u', 'view', ids(60))
    registerAuthzDegradationSink(() => { /* watching */ })
    const watched = await filterAuthorized(store(errored, allow), 'user:u', 'view', ids(60))

    expect(watched).toEqual(silent)
    expect(watched.size, 'the fixture stopped producing a mixed answer — this test proves nothing now')
      .toBeGreaterThan(0)
    expect(watched.size).toBeLessThan(60)
  })

  it('a sink that throws leaves the answer alone and does not escape', async () => {
    // Without the guard around the call, a broken logger would turn a DEGRADED read into a FAILED one:
    // logging would have changed the outcome, which is the one thing this port must never do.
    registerAuthzDegradationSink(() => { throw new Error('the log sink is on fire') })
    const out = await filterAuthorized(store((id) => id === 'p0'), 'user:u', 'view', ids(5))
    expect(out).toEqual(new Set(['p1', 'p2', 'p3', 'p4']))
  })
})

describe('#758: the port is wired to something', () => {
  let app: FastifyInstance
  beforeAll(async () => { app = await buildApp() }, 120_000)
  afterAll(async () => { await app?.close(); resetAuthzDegradationSink() })

  it('booting the server registers a sink', () => {
    // An observation port with nobody on the other end reports to nobody, and every test above would
    // still pass — they register their own. This asks the SHIPPED composition root instead.
    //
    // What it proves: the wiring exists. What it does not: that the line reads well in a log, which is
    // a human's judgement and not something a test can hold.
    expect(hasAuthzDegradationSink(), 'the server booted without giving the port a sink').toBe(true)
  })
})

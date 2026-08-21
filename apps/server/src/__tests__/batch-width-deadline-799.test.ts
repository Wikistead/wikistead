// #799 / ADR-247. A legitimate request at the documented cap (256 ids) turned into a 500 whenever the
// machine was busy, and the reader lost every link mark on the page at once.
//
// The cause is not the ids and not the model: it is HOW MANY checks travel in one round-trip. The
// store's request deadline is a budget for the whole trip, so the width decides whether an answer
// arrives. Measured on the isolated stack with the store held at 0.25 of a core — the CPU-starved
// shape that also reproduces the public runner:
//
//   width 50 → 8–12 of 50 answered, the rest `deadline_exceeded`, three attempts out of three
//   width 25 → 25 of 25 answered
//   width 10 → 10 of 10 answered, three out of three
//   width  5 →  5 of 5 answered
//
// Nothing changed between those rows but the width. So the fix is to ask again, narrower, for the ids
// the store went silent about — and the two failures this produces are one failure: the loud one is
// #799's refusal (a chunk in which NOTHING was answered is refused, correctly, so an at-cap request
// 500s), and the quiet one is a chunk in which only SOME ids went silent, where the survivors are
// denied and a live page is struck through as dead.
//
// What must NOT move: no id becomes allowed that the store did not allow, a store that cannot answer
// at any width is still refused rather than reported as "denied", and the healthy path is untouched.
import { describe, it, expect, afterEach } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import {
  filterAuthorized, registerAuthzDegradationSink, resetAuthzDegradationSink, type AuthzDegradation,
} from '@wikistead/authz'
import { registerAuthzHooks } from '@wikistead/hooks'

/**
 * A store with a deadline. Any round-trip carrying MORE than `answersUpTo` checks comes back with an
 * error on every entry — which is what a real OpenFGA does when the batch does not finish in time,
 * measured above. Narrower trips answer normally.
 */
function deadlineStore(answersUpTo: number, allow: (id: string) => boolean = () => true) {
  const widths: number[] = []
  const asked: string[] = []
  const client = {
    batchCheck: async (body: { checks: { object: string; correlationId?: string }[] }) => {
      widths.push(body.checks.length)
      const tooWide = body.checks.length > answersUpTo
      return {
        result: body.checks.map((c) => {
          const id = c.object.replace(/^[a-z_]+:/, '')
          asked.push(id)
          return tooWide
            ? {
                allowed: false, request: c, correlationId: c.correlationId!,
                error: { internal_error: 'deadline_exceeded', message: 'context deadline exceeded' },
              }
            : { allowed: allow(id), request: c, correlationId: c.correlationId! }
        }),
      }
    },
  } as unknown as OpenFgaClient
  return { client, widths, asked }
}

const ids = (n: number, p = 'p') => Array.from({ length: n }, (_, i) => `${p}${i}`)
const even = (id: string) => Number(id.replace(/^\D+/, '')) % 2 === 0

afterEach(() => {
  resetAuthzDegradationSink()
  registerAuthzHooks({ beforeCheck: undefined, afterCheck: undefined })
})

describe('#799: a batch too wide for the deadline is asked again, narrower', () => {
  it('a store that can only answer ten at a time still answers all fifty', async () => {
    const { client, widths } = deadlineStore(10, even)

    const out = await filterAuthorized(client, 'user:u', 'view', ids(50))

    // The verdicts are the store's own — not "everything" and not "nothing", which is what makes the
    // assertion say something: a fixture that allowed all fifty would pass with the retry deleted too.
    expect(out).toEqual(new Set(ids(50).filter(even)))
    expect(out.size).toBe(25)
    // One wide trip that failed, then the silent remainder in trips the store can afford.
    expect(widths[0], 'the first trip is still the wide one — the healthy path does not change').toBe(50)
    expect(widths.slice(1), 'the remainder is re-asked in narrower trips').toEqual([10, 10, 10, 10, 10])
  })

  it('the request at the documented cap is answered, not refused (the ticket)', async () => {
    // 256 is the cap ADR-117 fixed and the number the route lets through. Before this it reached the
    // store as six fifty-wide trips, and one of them going silent turned the whole page's link marks
    // into a 500.
    const { client } = deadlineStore(10, even)
    const out = await filterAuthorized(client, 'user:u', 'view', ids(256))
    expect(out).toEqual(new Set(ids(256).filter(even)))
    expect(out.size).toBe(128)
  })

  it('only the ids the store went silent about are asked again', async () => {
    // Re-asking a settled id would run `afterCheck` on it twice, which is an EE hook seeing the same
    // decision two times and a second chance to change it (ADR-152). It would also spend the deadline
    // this is trying to protect.
    const seen: string[] = []
    registerAuthzHooks({ afterCheck: async (ctx, allowed) => { seen.push(ctx.resource.id); return allowed } })
    // Errors on the first three ids at any width; the rest answer on the first trip.
    const answered = new Set<string>()
    const widths: number[] = []
    const client = {
      batchCheck: async (body: { checks: { object: string; correlationId?: string }[] }) => {
        widths.push(body.checks.length)
        return {
          result: body.checks.map((c) => {
            const id = c.object.replace(/^[a-z_]+:/, '')
            const broken = Number(id.slice(1)) < 3
            if (!broken) answered.add(id)
            return broken
              ? {
                  allowed: false, request: c, correlationId: c.correlationId!,
                  error: { internal_error: 'deadline_exceeded', message: 'context deadline exceeded' },
                }
              : { allowed: true, request: c, correlationId: c.correlationId! }
          }),
        }
      },
    } as unknown as OpenFgaClient

    const out = await filterAuthorized(client, 'user:u', 'view', ids(10))

    expect(widths, 'the second trip carries the three silent ids and nothing else').toEqual([10, 3])
    expect(out).toEqual(new Set(ids(10).filter((id) => Number(id.slice(1)) >= 3)))
    // Seven ids got a verdict, and each was shown to the hook exactly once.
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })

  it('what the narrower pass rescued is reported, so a near miss is not invisible', async () => {
    const reports: AuthzDegradation[] = []
    registerAuthzDegradationSink((d) => reports.push(d))
    const { client } = deadlineStore(10, even)

    await filterAuthorized(client, 'user:u', 'view', ids(50))

    expect(reports, 'one report for the chunk, not one per trip').toHaveLength(1)
    expect(reports[0].recovered, 'the store missed its deadline on all fifty and then answered them').toBe(50)
    expect(reports[0].unanswered, 'nobody lost a row').toBe(0)
    expect(reports[0].candidates).toBe(50)
    expect(reports[0].firstError).toMatch(/deadline_exceeded/)
  })

  it('a healthy store is asked once and reports nothing', async () => {
    // The break-check for the whole change: if the retry fired on a batch that was already answered,
    // every read in the product would cost a second round-trip and every one of them would log.
    const reports: AuthzDegradation[] = []
    registerAuthzDegradationSink((d) => reports.push(d))
    const { client, widths } = deadlineStore(50, even)

    const out = await filterAuthorized(client, 'user:u', 'view', ids(50))

    expect(widths).toEqual([50])
    expect(reports).toEqual([])
    expect(out).toEqual(new Set(ids(50).filter(even)))
  })

  it('a store that answers at NO width is still refused, never reported as denied', async () => {
    // #756 is unchanged. Asking again is a way to get an answer, not a way to give up more slowly:
    // when the narrower trips come back silent too, the chunk still has no verdict in it and saying
    // "denied" would be the lying-empty ADR-183 §3 forbids.
    const { client, widths } = deadlineStore(0)
    await expect(filterAuthorized(client, 'user:u', 'view', ids(50)))
      .rejects.toThrow(/answered none of 50/)
    expect(widths, 'it did try narrower before refusing').toEqual([50, 10, 10, 10, 10, 10])
  })

  it('a partly-silent chunk that stays silent still denies id-by-id (ADR-183 §3 unchanged)', async () => {
    // The store errors on three ids at every width, so the narrower pass changes nothing for them.
    // They are denied, the rest answer, and the call does not fail — the degradation this project
    // chose, reached the same way it was before.
    const client = {
      batchCheck: async (body: { checks: { object: string; correlationId?: string }[] }) => ({
        result: body.checks.map((c) => {
          const id = c.object.replace(/^[a-z_]+:/, '')
          return Number(id.slice(1)) < 3
            ? {
                allowed: false, request: c, correlationId: c.correlationId!,
                error: { internal_error: 'deadline_exceeded', message: 'context deadline exceeded' },
              }
            : { allowed: true, request: c, correlationId: c.correlationId! }
        }),
      }),
    } as unknown as OpenFgaClient
    const reports: AuthzDegradation[] = []
    registerAuthzDegradationSink((d) => reports.push(d))

    const out = await filterAuthorized(client, 'user:u', 'view', ids(10))

    expect(out).toEqual(new Set(ids(10).filter((id) => Number(id.slice(1)) >= 3)))
    expect(reports).toHaveLength(1)
    expect(reports[0].unanswered).toBe(3)
    expect(reports[0].recovered).toBe(0)
  })
})

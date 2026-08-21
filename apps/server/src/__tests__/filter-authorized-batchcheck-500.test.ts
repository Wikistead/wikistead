// #500 / ADR-183 — filterAuthorized over the server-side BatchCheck API. Pure, deterministic (a fake
// FGA exposing check + batchCheck), covering the ratified anti-test matrix:
//   1. equivalence      — the batch path's result set is byte-identical to a per-check pass
//   2. batch path RAN   — the fairness pin is non-vacuous: batchCheck is actually invoked (not per-id check)
//   3. no truncation    — > one batch (160 ids @ 50) — every id gets a verdict; allowed+denied === candidates
//   4. error granularity — an item error denies THAT id only; a transport error THROWS (never deny-all)
//   5. hook equivalence — beforeCheck short-circuit + afterCheck override are honored on the batch path
import { describe, it, expect, afterEach } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import { filterAuthorized } from '@wikistead/authz'
import { registerAuthzHooks } from '@wikistead/hooks'

// A fake FGA whose verdict for a given object is deterministic via `allow(id)`. It records every
// batchCheck call (chunk sizes) and every per-id check call, so a test can prove WHICH path ran.
function fakeFga(allow: (id: string) => boolean, opts: { errorFor?: (id: string) => boolean; throwBatch?: boolean; dropFor?: (id: string) => boolean } = {}) {
  const batchChunks: number[] = []
  const checkCalls: string[] = []
  const client = {
    check: async ({ object }: { object: string }) => {
      checkCalls.push(object)
      return { allowed: allow(object.replace(/^page:/, '')) }
    },
    batchCheck: async (body: { checks: { user: string; relation: string; object: string; correlationId?: string }[] }) => {
      if (opts.throwBatch) throw new Error('rpc transport error')
      batchChunks.push(body.checks.length)
      return {
        // #816: `dropFor` omits the entry ENTIRELY rather than marking it errored. The server answers
        // with a map and the SDK folds it into a list, so an id the store never spoke about simply has
        // no element here — which is a different shape from an element carrying an error, and the one
        // nothing was measuring.
        result: body.checks.flatMap((c) => {
          const id = c.object.replace(/^page:/, '')
          if (opts.dropFor?.(id)) return []
          return [opts.errorFor?.(id)
            ? { allowed: false, request: c, correlationId: c.correlationId!, error: { message: 'item deadline' } }
            : { allowed: allow(id), request: c, correlationId: c.correlationId! }]
        }),
      }
    },
  } as unknown as OpenFgaClient
  return { client, batchChunks, checkCalls }
}

afterEach(() => registerAuthzHooks({ beforeCheck: undefined, afterCheck: undefined }))

describe('#500 / ADR-183: filterAuthorized over server-side BatchCheck', () => {
  it('1+2: equivalence with a per-check pass, and the BATCH path actually ran (non-vacuous fairness)', async () => {
    const ids = Array.from({ length: 137 }, (_, i) => `p${i}`)
    const allow = (id: string) => Number(id.slice(1)) % 3 !== 0 // deny every 3rd
    const { client, batchChunks, checkCalls } = fakeFga(allow)

    const out = await filterAuthorized(client, 'user:u', 'view', ids)

    // byte-identical to the per-check semantics
    const expected = new Set(ids.filter(allow))
    expect(out).toEqual(expected)
    // the batch path ran: batchCheck was invoked, per-id check was NOT (would be the old fan-out / a fallback)
    expect(batchChunks.length).toBeGreaterThan(0)
    expect(checkCalls).toHaveLength(0)
  })

  it('3: > one batch (160 ids @ 50) — every id gets a verdict, none silently dropped', async () => {
    const ids = Array.from({ length: 160 }, (_, i) => `q${i}`)
    const allow = (id: string) => Number(id.slice(1)) % 2 === 0
    const { client, batchChunks } = fakeFga(allow)

    const out = await filterAuthorized(client, 'user:u', 'view', ids)

    // chunked at 50 → 4 batches (50,50,50,10), summing to every id
    expect(batchChunks).toEqual([50, 50, 50, 10])
    expect(batchChunks.reduce((a, b) => a + b, 0)).toBe(160)
    // allowed + denied === candidates (no id fell through)
    const allowed = out.size
    const denied = ids.filter((id) => !out.has(id)).length
    expect(allowed + denied).toBe(160)
    expect(out).toEqual(new Set(ids.filter(allow)))
  })

  it('4a: an ITEM error denies THAT id only (fail closed per id, never a throw)', async () => {
    const ids = ['a', 'b', 'c', 'd']
    const { client } = fakeFga(() => true, { errorFor: (id) => id === 'b' })
    const out = await filterAuthorized(client, 'user:u', 'view', ids)
    // b errored → denied; the rest still resolve
    expect(out).toEqual(new Set(['a', 'c', 'd']))
  })

  it('4b: a TRANSPORT error THROWS (never deny-all → never the lying-empty 200)', async () => {
    const { client } = fakeFga(() => true, { throwBatch: true })
    await expect(filterAuthorized(client, 'user:u', 'view', ['a', 'b'])).rejects.toThrow(/transport/)
  })

  // #756. 4a and 4b sat next to each other for months and left the room between them empty: 4a errors ONE
  // id, 4b kills the TRANSPORT, and neither asks what happens when the call succeeds and every item inside
  // it errors. Applying 4a's rule that many times lands on 4b's forbidden outcome by arithmetic — deny-all,
  // 200 + empty, the lying-empty this ADR names by that word. It is not hypothetical: a CPU-starved store
  // returns exactly this (`18 of 18 answered, 0 allowed, 18 item-errors — deadline_exceeded`) and the page
  // tree went empty while nine rows sat in SQL. It was the public CI's standing red.
  it('4c: EVERY item erroring is a failure, not a set of denials (the room between 4a and 4b)', async () => {
    const { client } = fakeFga(() => true, { errorFor: () => true })
    await expect(filterAuthorized(client, 'user:u', 'view', ['a', 'b', 'c']))
      .rejects.toThrow(/answered none of 3/)
  })

  it('4d: a chunk that answers nothing fails the whole call — a later good chunk cannot cover for it', async () => {
    // The same loss at 50-id granularity: with 60 ids the first chunk errors wholesale and the second
    // answers cleanly. Reporting the survivors would be a shorter list that looks complete, which is the
    // silent truncation anti-test 3 exists to forbid — the caller cannot tell 50 denials from 50 silences.
    const ids = Array.from({ length: 60 }, (_, i) => `r${i}`)
    const { client } = fakeFga(() => true, { errorFor: (id) => Number(id.slice(1)) < 50 })
    await expect(filterAuthorized(client, 'user:u', 'view', ids)).rejects.toThrow(/answered none of 50/)
  })

  // #816. 4c closed the door where every entry comes back ERRORED. The store has a third one: the call
  // succeeds and the response carries NO ENTRY AT ALL for an id. The code counted the ways an answer can
  // be bad instead of counting the ids that got one, so a response with no entries counted zero of them
  // as unanswered — the degradation report stayed quiet, the refusal never fired, and the whole chunk
  // was denied in silence. The amendment's own words ("a chunk that yields no error-free verdict
  // throws") already covered this; the arithmetic did not reach it.
  it('4f: a response with NO ENTRIES is a failure, not a set of denials (the third door)', async () => {
    const { client } = fakeFga(() => true, { dropFor: () => true })
    await expect(filterAuthorized(client, 'user:u', 'view', ['a', 'b', 'c']))
      .rejects.toThrow(/answered none of 3/)
  })

  it('4g: a PARTLY missing response denies the missing ids and still answers for the rest', async () => {
    // The break-check for 4f: the fix must not have turned "fewer rows" into "an error page" here
    // either. Fail-closed for the ids the store did not speak about is the behaviour ADR-183 §3 chose,
    // and it is unchanged — what changes is that those ids are now COUNTED, which is what lets both the
    // report and the refusal see them.
    const ids = Array.from({ length: 10 }, (_, i) => `t${i}`)
    const { client } = fakeFga(() => true, { dropFor: (id) => Number(id.slice(1)) % 2 === 0 })
    const out = await filterAuthorized(client, 'user:u', 'view', ids)
    expect(out).toEqual(new Set(ids.filter((id) => Number(id.slice(1)) % 2 === 1)))
  })

  it('4e: the INTENDED degradation survives — a partly-errored chunk still answers, minus those ids', async () => {
    // The break-check for the fix itself: it must not have turned "fewer rows" into "an error page".
    // Half the ids error, half answer; the caller gets the half that answered.
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`)
    const { client } = fakeFga(() => true, { errorFor: (id) => Number(id.slice(1)) % 2 === 0 })
    const out = await filterAuthorized(client, 'user:u', 'view', ids)
    expect(out).toEqual(new Set(ids.filter((id) => Number(id.slice(1)) % 2 === 1)))
  })

  it('5a: beforeCheck short-circuits per id BEFORE the batch (short-circuited ids never enter it)', async () => {
    const seenByBatch: string[] = []
    const { client } = (() => {
      const c = {
        check: async () => ({ allowed: true }),
        batchCheck: async (body: { checks: { object: string; correlationId?: string; relation: string; user: string }[] }) => {
          for (const chk of body.checks) seenByBatch.push(chk.object.replace(/^page:/, ''))
          return { result: body.checks.map((k) => ({ allowed: true, request: k, correlationId: k.correlationId! })) }
        },
      } as unknown as OpenFgaClient
      return { client: c }
    })()
    // deny 'x' before FGA; everything else passes through to the batch
    registerAuthzHooks({ beforeCheck: async (ctx) => (ctx.resource.id === 'x' ? false : undefined) })
    const out = await filterAuthorized(client, 'user:u', 'view', ['x', 'y', 'z'])
    expect(out).toEqual(new Set(['y', 'z'])) // x denied by the hook
    expect(seenByBatch).toEqual(['y', 'z']) // x never reached the batch
  })

  it('5b: afterCheck overrides the batch verdict per id (ADR-152 preserved on the batch path)', async () => {
    const { client } = fakeFga(() => true) // FGA allows everything
    // hook denies id 'no', passes the rest through
    registerAuthzHooks({ afterCheck: async (ctx, fga) => (ctx.resource.id === 'no' ? false : fga) })
    const out = await filterAuthorized(client, 'user:u', 'view', ['yes1', 'no', 'yes2'])
    expect(out).toEqual(new Set(['yes1', 'yes2']))
  })

  // #489: listSpaces batches the per-space capability fan-out through filterAuthorized with the SPACE
  // resource type. Pin that the type parameter drives BOTH the relation mapping (RELATION.space) and the
  // object prefix, and that omitting it stays byte-identical to the page callers.
  it('#489: a non-page resource type resolves the space relation + `space:` object; default stays page', async () => {
    const objects: string[] = []
    const relations = new Set<string>()
    const client = {
      check: async () => { throw new Error('per-id check must not run on the batch path') },
      batchCheck: async (body: { checks: { object: string; relation: string; correlationId?: string }[] }) => {
        for (const c of body.checks) { objects.push(c.object); relations.add(c.relation) }
        return { result: body.checks.map((c) => ({ allowed: c.object === 'space:s1', request: c, correlationId: c.correlationId! })) }
      },
    } as unknown as OpenFgaClient

    // 'manage' on a SPACE → FGA relation `manager`, object `space:<id>` (not page:). Equivalence: only s1 allowed.
    const out = await filterAuthorized(client, 'user:u', 'manage', ['s1', 's2'], undefined, 'space')
    expect(objects).toEqual(['space:s1', 'space:s2'])
    expect([...relations]).toEqual(['manager']) // RELATION.space.manage → 'manager'
    expect(out).toEqual(new Set(['s1']))

    // Omitting the type defaults to 'page' — byte-identical to every existing page caller.
    objects.length = 0; relations.clear()
    await filterAuthorized(client, 'user:u', 'manage', ['p1'])
    expect(objects).toEqual(['page:p1'])
    expect([...relations]).toEqual(['manage']) // RELATION.page.manage → 'manage'
  })
})

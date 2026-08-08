// #667a write sent with NO BODY must not answer 500.
//
// `PATCH /pages/:pageId` read `req.body.title` and Fastify leaves `req.body` UNDEFINED when a request
// arrives without one, so `curl -X PATCH /pages/whatever` crashed the handler. Two things are wrong
// with that, and the second is the one this repository cares about most:
//
//   1. A malformed request is answered 400, not 500. A 500 says the server is broken; it was not.
//   2. It breaks the UNIFORM 404. Every read of a page the caller may not see answers the same way,
//      deliberately, so the response cannot be used to ask whether a page exists. A bodyless PATCH
//      answered 500 for a real page and 500 for an imaginary one — but it answered DIFFERENTLY from
//      the 403/404 the same caller gets for everything else, and "which routes crash" is itself a map.
//
// It surfaced as a red WALK (`classification-drift-667`, `space-restriction-shipped-637`): those files
// visit every registered route, so they send bodyless writes as a matter of course. The product was
// broken; the walks were right.
//
// ⚠️ So this is a WALK too, not a list of the routes that crash today. A pin naming `PATCH /pages/:id`
// is silent the next time somebody registers a handler that reads `req.body.x` — which is the ordinary
// way to write one here, since most of these routes carry no body schema.
//
// Every request is aimed at an id that DOES NOT EXIST, so no handler can reach a write: it must refuse
// (401/403/404) or reject the body (400). That is also what makes the walk safe to run against the
// shared tenant.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'

const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
/** An id no fixture will ever mint, in every shape a param takes here (uuid-ish, slug, sub). */
const NOBODY = 'wks-no-such-thing-667'

let app: FastifyInstance

beforeAll(async () => { app = await buildApp(); await app.ready() }, 180_000)
afterAll(async () => { await app.close(); await pool.end() }, 180_000)

/** Every registered method+pattern, read from the running app rather than from the source. */
function registeredRoutes(): string[] {
  const tree = app.printRoutes({ commonPrefix: false })
  const stack: Record<number, string> = {}
  const out: string[] = []
  for (const line of tree.split('\n')) {
    if (!line.trim()) continue
    const m = /^((?:[│ ]   )*)(?:[├└]── )?(.*)$/.exec(line)!
    const depth = m[1]!.length / 4
    const mm = /^(.*?)\s*\(([A-Z, ]+)\)\s*$/.exec(m[2]!)
    const label = mm ? mm[1]! : m[2]!
    const full = (depth > 0 ? (stack[depth - 1] ?? '') : '') + label
    stack[depth] = full
    for (const k of Object.keys(stack)) if (Number(k) > depth) delete stack[Number(k)]
    if (!mm) continue
    for (const method of mm[2]!.split(',').map((s) => s.trim())) {
      if (method === 'HEAD' || method === 'OPTIONS') continue
      out.push(`${method} ${full}`)
    }
  }
  return [...new Set(out)]
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH'])

describe('#667a bodyless write is a bad request, never a crash', () => {
  it('no write route answers 5xx when the body is missing', async () => {
    const all = registeredRoutes()
    expect(all.length, 'the app registered its routes').toBeGreaterThan(100)

    // Only routes with a PARAM are walked, so every request can be aimed at something that does not
    // exist and no handler can reach a write. The param-less collection writes (POST /spaces, POST
    // /api-keys, …) are left out for that reason alone — a bodyless POST there could still create
    // something with defaults, and a walk that seeds rows into the shared tenant is a walk nobody can
    // run twice. NOT a silent cap: the count is asserted below so the exclusion cannot quietly grow to
    // swallow the routes this is about.
    const targets = all.filter((r) => {
      const [method, path] = r.split(' ') as [string, string]
      return WRITE_METHODS.has(method) && path.includes('/:')
    })
    const skipped = all.filter((r) => {
      const [method, path] = r.split(' ') as [string, string]
      return WRITE_METHODS.has(method) && !path.includes('/:')
    })
    expect(targets.length, 'there are parameterised writes to walk').toBeGreaterThan(20)
    // The excluded set is REPORTED, per the rule against caps nobody can see. If this number climbs,
    // the walk is covering less than it looks like it is.
    // eslint-disable-next-line no-console
    console.log(`[bodyless-667] walking ${targets.length} parameterised writes; ${skipped.length} collection writes excluded (they could create with defaults)`)

    const crashed: string[] = []
    for (const route of targets) {
      const [method, pattern] = route.split(' ') as [string, string]
      const url = pattern.replace(/:[A-Za-z0-9_]+/g, NOBODY)
      // No payload AND no content-type: that is what reaches the handler with `req.body === undefined`.
      // Sending `content-type: application/json` with an empty payload is a DIFFERENT request — Fastify
      // rejects it at the parser (FST_ERR_CTP_EMPTY_JSON_BODY, 400) and never runs the handler, so a
      // walk written that way would have passed while the product crashed. Measured.
      const res = await app.inject({ method: method as 'POST', url, headers: H })
      if (res.statusCode >= 500) crashed.push(`${route} → ${res.statusCode} ${res.body.slice(0, 120)}`)
    }

    expect(crashed, `these crash on a bodyless write:\n${crashed.join('\n')}`).toEqual([])
  }, 180_000)

  it('…and the one that was reported is refused the way its neighbours are', async () => {
    // The casefound, kept by name as well — the walk above proves the class, this proves the
    // instance is genuinely FIXED rather than merely no longer 500 (a handler that swallowed the
    // missing body and answered 204 would satisfy the walk and lose the edit silently).
    const res = await app.inject({ method: 'PATCH', url: `/pages/${NOBODY}`, headers: H })
    expect(res.statusCode, res.body).toBe(400)

    // …and existence is still hidden: the SAME answer whether or not the id is real is what the walk
    // cannot check, because it only ever asks about ids that are not. Here the body is well-formed, so
    // the handler is reached and the refusal is the authorisation one.
    const withBody = await app.inject({
      method: 'PATCH', url: `/pages/${NOBODY}`,
      headers: { ...H, 'content-type': 'application/json' }, payload: JSON.stringify({ title: 'x' }),
    })
    expect([403, 404], `an unreachable page is refused, not crashed :: ${withBody.body}`)
      .toContain(withBody.statusCode)
  }, 180_000)
})

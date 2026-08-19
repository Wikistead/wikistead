// #756, raised in review of the fix: the new "the store answered nothing" error carries the detail an
// operator needs — how many checks were in flight, on which relation and type — and that detail must
// never leave the building.
//
// `chunk.length` is a count of CANDIDATES, taken before any authorization ran. On a tree branch it is
// how many pages are there, private and draft ones included; #623 §4 redesigned the chevron precisely
// so a reader could not learn that number. `relation` is a word out of model.fga — `access_manager`,
// `settings_editor` — which #619 ruled stays inside. Before this test, the message went out verbatim as
// the body of a 500, because `app.ts` only withholds the text of errors that speak FGA's words and this
// one did not say any of them.
//
// The test asks THE SHIPPED HANDLER. Copying app.ts's pattern here would pin a copy, and the copy would
// keep passing on the day the real one changed (#637's lesson). So it boots the real app, makes a route
// throw the real error, and reads the response the way a browser would.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { filterAuthorized } from '@wikistead/authz'
import type { OpenFgaClient } from '@openfga/sdk'

// A store that accepts the call and then errors every item inside it — the shape a saturated OpenFGA
// returns, and the one that used to come back to the reader as an empty tree.
const silentStore = {
  batchCheck: async (body: { checks: { object: string; correlationId?: string }[] }) => ({
    result: body.checks.map((c) => ({
      allowed: false, request: c, correlationId: c.correlationId!,
      error: { internal_error: 'deadline_exceeded', message: 'context deadline exceeded' },
    })),
  }),
} as unknown as OpenFgaClient

let app: FastifyInstance
let thrown: string

beforeAll(async () => {
  app = await buildApp()
  // Route names are arbitrary; what matters is that the error reaches the app's own error handler.
  app.get('/__756_probe', async () => {
    await filterAuthorized(silentStore, 'user:u', 'manage', ['p1', 'p2', 'p3'], undefined, 'space')
    return { unreachable: true }
  })
  await app.ready()
  thrown = await filterAuthorized(silentStore, 'user:u', 'manage', ['p1', 'p2', 'p3'], undefined, 'space')
    .then(() => '(did not throw)').catch((e: unknown) => String((e as Error).message))
}, 120_000)

afterAll(async () => { await app?.close() })

describe('#756: the store-silent error tells the operator and not the reader', () => {
  it('the thrown message DOES carry the detail (this is what the operator log gets)', () => {
    // Asserted so the redaction test below cannot pass by the detail having quietly disappeared —
    // a message with nothing in it would satisfy every leak check in this file and help nobody.
    expect(thrown, 'the error stopped naming the relation it was asking about').toMatch(/access_manager|manage/)
    expect(thrown, 'the error stopped naming how many checks were in flight').toMatch(/\b3\b/)
  })

  it('the RESPONSE names no count, no relation and no resource type', async () => {
    // The Host header is not decoration: this server routes by tenant subdomain, and a bare request
    // answers 404 before it ever reaches the handler under test.
    const res = await app.inject({ method: 'GET', url: '/__756_probe', headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
    expect(res.statusCode).toBe(500)
    const body = res.body
    // The three things the message carries, none of which may be in what a client reads.
    expect(body, `the candidate count reached the client:\n${body}`).not.toMatch(/\b3\b/)
    expect(body, `an FGA relation name reached the client:\n${body}`).not.toMatch(/access_manager|manage/)
    expect(body, `the resource type reached the client:\n${body}`).not.toMatch(/space/)
    // …and it is the redaction that did it, not an accident of wording.
    expect(JSON.parse(body).code).toBe('authz_store_error')
  })
})

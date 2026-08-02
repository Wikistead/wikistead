// #583: the two email toggles on /settings/account did nothing.
//
// `PATCH /me/settings` declared `emailImmediate` and `emailDigest` in its body type and then did not
// pass them to `updateAccountSettings`, which had both branches implemented and waiting. The request
// answered 204, the UI drew the new state, and the reload put it back. Both fields are optional, so
// the type system saw a valid call; every existing test called `updateAccountSettings` directly, so
// the suite exercised the half that worked.
//
// Two pins, because one is not enough here:
//   1. through the ROUTE — the layer that was broken. This is the regression pin.
//   2. a structural one comparing what the handler DECLARES against what it FORWARDS, which fails on
//      the next field added to the body type and dropped on the way through. The bug is a class, not
//      an incident: nine fields are forwarded by hand in one long object literal.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance
let before: { email_immediate: boolean; email_digest: boolean } | undefined

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  ;[before] = await admin<{ email_immediate: boolean; email_digest: boolean }[]>`
    SELECT email_immediate, email_digest FROM members WHERE tenant_id = ${TENANT} AND sub = 'dev-user'`
}, 60_000)

afterAll(async () => {
  if (before) {
    await admin`UPDATE members SET email_immediate = ${before.email_immediate}, email_digest = ${before.email_digest}
      WHERE tenant_id = ${TENANT} AND sub = 'dev-user'`.catch(() => {})
  }
  await app.close(); await admin.end(); await pool.end()
}, 60_000)

const patch = (body: object) => app.inject({ method: 'PATCH', url: '/me/settings', headers: H, payload: body })
const read = async () => (await app.inject({ method: 'GET', url: '/me/settings', headers: H })).json()

describe('#583: the email toggles survive the round trip', () => {
  it('turning immediate email OFF persists', async () => {
    const res = await patch({ emailImmediate: false })
    expect(res.statusCode).toBeLessThan(300)
    expect((await read()).emailImmediate, 'the reload used to put it straight back').toBe(false)
    const [row] = await admin<{ email_immediate: boolean }[]>`
      SELECT email_immediate FROM members WHERE tenant_id = ${TENANT} AND sub = 'dev-user'`
    expect(row!.email_immediate, 'and the column agrees — not just the response').toBe(false)
  }, 60_000)

  it('turning digest ON persists, and the two are independent', async () => {
    await patch({ emailDigest: true })
    const after = await read()
    expect(after.emailDigest).toBe(true)
    expect(after.emailImmediate, 'the other toggle is untouched by this write').toBe(false)
    await patch({ emailImmediate: true })
    expect(await read()).toMatchObject({ emailImmediate: true, emailDigest: true })
  }, 60_000)

  it('a non-boolean is refused rather than coerced', async () => {
    const res = await patch({ emailDigest: 'yes' })
    expect(res.statusCode, 'the validation in updateAccountSettings is now actually reachable').toBe(400)
  }, 60_000)
})

describe('#583: every field the handler accepts is a field it passes on', () => {
  it('the declared body keys and the forwarded keys are the same set', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../routes/account.ts'), 'utf8')
    // anchor on the PATCH itself: `/me/settings` also appears on the GET route above it
    const start = src.indexOf('app.patch<')
    const at = src.indexOf("'/me/settings'", start)
    expect(start >= 0 && at > start, 'the PATCH handler is where this test thinks it is').toBe(true)
    // the body type sits in the generic before the route path, the forwarded literal in the call after
    const declared = src.slice(start, at)
    const forwarded = src.slice(at, src.indexOf('\n  )', at))
    const keys = (block: string, re: RegExp) => new Set([...block.matchAll(re)].map((m) => m[1]!))
    const declaredKeys = keys(declared, /(\w+)\??:\s*(?:string|boolean|number|unknown|Record<|string\[\])/g)
    const forwardedKeys = keys(forwarded, /(\w+):\s*req\.body\?\./g)
    expect(declaredKeys.size, 'the body type was parsed').toBeGreaterThan(5)
    expect([...declaredKeys].filter((k) => !forwardedKeys.has(k)),
      'these are accepted by the route and then dropped on the floor — the #583 shape').toEqual([])
  })
})

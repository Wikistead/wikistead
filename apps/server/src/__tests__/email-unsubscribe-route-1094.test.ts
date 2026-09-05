// #1094: the confirmation page's own POST form action must actually reach the server it renders on.
//
// The defect: `email-unsubscribe.ts` registers its routes at the bare path (`/email/unsubscribe`), but
// wrote the confirmation page's <form action> as that SAME bare path. A browser resolves a bare path
// against the page's own origin, and this origin's only route to the server is `/api/*` (the edge
// strips `/api` before forwarding — infra/routes/origin-routes.mjs, ADR-231). A bare `/email/unsubscribe`
// therefore falls through to the `/` catch-all and hits the SPA, not this handler. `app.inject` (used by
// unsubscribe-547.test.ts) calls the Fastify route directly and never notices — it doesn't go through
// an edge at all.
//
// ⚠️ This does NOT hardcode "/api" in its assertion. Asserting the literal string only proves today's
// prefix; it would stay green if the route table's shape changed and the two drifted again in some new
// way. Instead this resolves the rendered action THROUGH the real route table (the same one the dev
// proxy and edges are built from) and asserts the result is (a) routed to the server upstream at all,
// and (b) lands on exactly the path this file registers its handler at. That ties the two together by
// the mechanism, not by a copy of the string.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { mintUnsubToken } from '@wikistead/auth'
import { buildApp } from '../app.js'
// Typed via the sibling origin-routes.d.ts ambient declaration (the .mjs itself ships no types).
import { ORIGIN_ROUTES } from '../../../../infra/routes/origin-routes.mjs'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const SUB = `unsub1094-${STAMP}`
const cfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 3600 }
const host = { host: 'dev.localhost' }

/** The path Fastify actually serves this handler at, per this same file's `app.get`/`app.post` calls. */
const REGISTERED_SERVER_PATH = '/email/unsubscribe'

/**
 * Resolve a browser-relative path THROUGH the edge, exactly as the dev proxy / Caddy / ingress would:
 * the longest matching row wins, its `strip` flag decides whether the server sees the prefix, and no
 * match at all means the `/` catch-all — i.e. the SPA, never the server. Mirrors the matching this
 * file's sibling checks (`check-origin-routes.mjs`, `mail-address-topologies-828.test.ts`) already use
 * against this same table, so a route-table change that keeps the mapping consistent stays green here.
 */
function resolveThroughEdge(path: string): { upstream: string; serverPath: string } {
  const candidates = ORIGIN_ROUTES.filter((r) => path === r.path || path.startsWith(`${r.path}/`))
  const route = candidates.sort((a, b) => b.path.length - a.path.length)[0]
  if (!route) return { upstream: 'web', serverPath: path } // unmatched → the `/` catch-all → the SPA
  return { upstream: route.upstream, serverPath: route.strip ? path.slice(route.path.length) : path }
}

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await adminPool`INSERT INTO members (tenant_id, sub, display_name, email) VALUES (${TENANT}, ${SUB}, ${SUB}, ${`${SUB}@t.test`})`
}, 60_000)

afterAll(async () => {
  await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub = ${SUB}`.catch(() => {})
  await app.close(); await adminPool.end(); await pool.end()
}, 60_000)

describe('#1094: the confirmation page form action reaches the server through the real edge table', () => {
  it('the rendered <form action> resolves, through ORIGIN_ROUTES, to this file\'s own registered route', async () => {
    const token = await mintUnsubToken(cfg, { tenantId: TENANT, sub: SUB, action: 'immediate' })
    const page = await app.inject({ method: 'GET', url: `/email/unsubscribe?token=${encodeURIComponent(token)}`, headers: host })
    expect(page.statusCode).toBe(200)

    const actionMatch = /<form method="post" action="([^"]+)">/.exec(page.body)
    expect(actionMatch, 'the confirmation page must render exactly one POST form').not.toBeNull()
    const action = actionMatch![1]!.replace(/&amp;/g, '&') // the handler HTML-escapes the attribute

    const pathname = new URL(action, 'https://x.test').pathname
    const resolved = resolveThroughEdge(pathname)

    // The break this pin exists for: a bare action resolves to `upstream: 'web'` (no row matches),
    // which is exactly what shipped — the button posted to the SPA and the handler was never reached.
    expect(resolved.upstream, `action "${action}" must route to the server, not the SPA or collab`).toBe('server')
    expect(resolved.serverPath, 'once through the edge, the path must be exactly what this file registers').toBe(REGISTERED_SERVER_PATH)
  }, 60_000)
})

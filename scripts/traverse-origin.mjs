#!/usr/bin/env node
// #724 / ADR-231 §4: walk the real origin — one probe per table row.
//
// This is the PRIMARY defence, and the checker (check-origin-routes) is the cheap secondary one.
// The reason for the order: a text comparison finds a missing rule, but the defect that hid longest
// was a rule that WAS there and did not match — Caddy's `handle /collab/*` against the bare
// `/collab` the provider opens. Only traffic can tell you that.
//
// Every probe asserts the answer did not come from the SPA. That is the actual failure mode here:
// the static container answers index.html with a 200, so a status-code check reads total breakage
// as success. (The same blindness is why the pre-deploy `api-404-json` row passed on a stack where
// nothing routed to the server at all.)
//
// Usage:  node scripts/traverse-origin.mjs --base http://localhost:8080 [--host app.example]
//         [--token <bearer>] [--scim-token <scm_…>]
// Exit 0 only when every probe passes. Rows needing a credential SKIP without one and say so —
// a skip is printed, never silently counted as a pass.
import { ORIGIN_ROUTES } from '../infra/routes/origin-routes.mjs'

const arg = (name, fallback = undefined) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const base = (arg('base') ?? 'http://localhost:8080').replace(/\/$/, '')
const host = arg('host')
const token = arg('token')
const scimToken = arg('scim-token')
const headers = host ? { host } : {}

const isSpa = (body, contentType) =>
  /text\/html/i.test(contentType || '') && /<div id="root"|<script type="module"/i.test(body)

/** One probe per row: what that path is FOR, plus "the SPA did not answer this". */
const PROBES = {
  '/api': {
    auth: 'api',
    path: '/api/healthz',
    expect: (r, body) => (r.status === 200 ? null : `expected 200 from a real API endpoint, got ${r.status}`),
  },
  '/collab': { path: '/collab', ws: true },
  '/auth': {
    path: '/auth/login',
    // A 302 when an IdP is configured, a JSON 404 when not — both are the SERVER answering. The
    // SPA check below is what actually decides this row.
    expect: () => null,
  },
  '/signup': { path: '/signup/login', expect: () => null },
  '/pub': { path: '/pub/__traversal_probe__', expect: () => null },
  '/robots.txt': {
    path: '/robots.txt',
    expect: (r, body, ct) => (/text\/plain/i.test(ct || '') ? null : `robots.txt must be text/plain, got ${ct || '(none)'} — the SPA shell serves 200 HTML here and voids the public switch`),
  },
  '/sitemap.xml': {
    path: '/sitemap.xml',
    expect: (r, body, ct) => (/xml/i.test(ct || '') ? null : `sitemap must be XML, got ${ct || '(none)'}`),
  },
  '/.well-known/oauth-authorization-server': { path: '/.well-known/oauth-authorization-server', json: true },
  '/.well-known/oauth-protected-resource': { path: '/.well-known/oauth-protected-resource', json: true },
  '/mcp': {
    path: '/mcp',
    expect: (r) => ([400, 401, 404, 405].includes(r.status) ? null : `expected the MCP endpoint to answer, got ${r.status}`),
  },
  '/mcp/oauth': { path: '/mcp/oauth/authorize', expect: () => null },
  '/webhooks/stripe': {
    path: '/webhooks/stripe',
    method: 'POST',
    // 400/401 = signature refused; 503 = billing not configured in this deployment. All three are
    // the SERVER answering, which is the whole question here — the "not the SPA" check above is
    // what decides the row.
    expect: (r) => ([400, 401, 503].includes(r.status) ? null : `an unsigned Stripe callback must be refused by the SERVER, got ${r.status}`),
  },
  '/scim/v2': {
    path: '/scim/v2/ServiceProviderConfig',
    needs: 'scim-token',
    json: true,
    expect: (r) => (r.status === 200 ? null : `expected the SCIM discovery document, got ${r.status}`),
  },
  '/': {
    path: '/',
    expect: (r, body, ct) => (isSpa(body, ct) ? null : 'the root must serve the SPA shell'),
    spaIsCorrect: true,
  },
}

async function probeWs(url) {
  // The upgrade handshake, by hand: 101 proves the socket reached the collab service, and a 200
  // proves it reached the static site instead (the exact shape of the Caddy bug).
  //
  // node:http, not fetch: undici treats a 101 as a protocol error and throws, so the first version
  // of this probe reported "status 0" for a socket curl had already shown answering 101 — a
  // measurement bug dressed as a defect.
  const http = await import('node:http')
  const u = new URL(url)
  return await new Promise((resolve) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    })
    const done = (msg) => { try { req.destroy() } catch {} resolve(msg) }
    req.on('upgrade', (res, socket) => { socket.destroy(); done(res.statusCode === 101 ? null : `upgrade answered ${res.statusCode}`) })
    req.on('response', (res) => done(`the handshake got a plain ${res.statusCode} response instead of an upgrade — the socket is not reaching the collab service`))
    req.on('error', (e) => done(`the handshake failed: ${e.message}`))
    req.setTimeout(10_000, () => done('the handshake timed out'))
    req.end()
  })
}

let failed = 0
let skipped = 0
for (const route of ORIGIN_ROUTES) {
  const probe = PROBES[route.path]
  if (!probe) {
    console.error(`FAIL ${route.path.padEnd(42)} no probe for this row — every table row must be walked (add one here)`)
    failed++
    continue
  }
  if (probe.needs === 'scim-token' && !scimToken) {
    console.log(`SKIP ${route.path.padEnd(42)} needs --scim-token (mint one through the admin API first)`)
    skipped++
    continue
  }
  const url = `${base}${probe.path}`
  let problem = null
  if (probe.ws) {
    problem = await probeWs(url)
  } else {
    const r = await fetch(url, {
      method: probe.method ?? 'GET',
      redirect: 'manual',
      headers: {
        ...headers,
        // Only where the row needs one. The first version sent the API bearer to every path, and
        // /mcp answered 404 to a token that is not an MCP token — a probe artefact, not a defect.
        ...(probe.auth === 'api' && token ? { authorization: `Bearer ${token}` } : {}),
        ...(probe.needs === 'scim-token' ? { authorization: `Bearer ${scimToken}` } : {}),
      },
    }).catch((e) => ({ status: 0, headers: new Headers(), text: async () => String(e.message) }))
    const ct = r.headers?.get?.('content-type') ?? ''
    const body = await r.text()
    if (!probe.spaIsCorrect && isSpa(body, ct)) {
      problem = `the SPA shell answered (status ${r.status}) — this path is not reaching its service`
    } else if (probe.json && !/application\/json/i.test(ct)) {
      problem = `expected JSON, got ${ct || '(none)'}`
    } else {
      problem = probe.expect?.(r, body, ct) ?? null
    }
  }
  if (problem) {
    console.error(`FAIL ${route.path.padEnd(42)} ${problem}`)
    failed++
  } else {
    console.log(`ok   ${route.path.padEnd(42)} ${probe.path}`)
  }
}

console.log(`\n${ORIGIN_ROUTES.length} row(s): ${ORIGIN_ROUTES.length - failed - skipped} ok, ${failed} failed, ${skipped} skipped`)
if (failed) {
  console.error('traverse-origin: the running origin does not serve the route table (#724 / ADR-231).')
  process.exit(1)
}

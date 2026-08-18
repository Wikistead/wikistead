#!/usr/bin/env node
// #724 / ADR-231: the edge configs are CHECKED against the one origin route table.
//
// The defect this exists to catch: the public path → service mapping was written three times (the
// dev proxy, deploy/caddy/Caddyfile, deploy/k8s/base/ingress.yaml) and nothing compared them. They
// drifted until a deployed stack answered 404 to every api call, sign-in could not start, and
// robots.txt was served as index.html. The dev proxy is now GENERATED from the table
// (apps/web/vite.config.ts), so this checks the two that stay hand-written — they carry TLS,
// timeouts and header policy that a generator would flatten (owner rulingcheck, not
// generate, in v1).
//
// What this check can and cannot do — stated plainly, because the limit is the reason ADR-231 also
// requires a traversal: this compares TEXT. It catches a missing row and an unexpected route. It
// does NOT catch a matcher that is present but does not match what the client actually sends —
// which is exactly how `handle /collab/*` failed against the bare `/collab` the provider opens. The
// release-side traversal (one probe per row, through a built image and a real proxy) is the
// primary defence; this is the cheap one that runs on every commit.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORIGIN_ROUTES, PROXIED_ROUTES, NOT_EDGE_ROUTES } from '../infra/routes/origin-routes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

if (PROXIED_ROUTES.length === 0) problems.push('the route table has no proxied rows — a torn or empty table cannot guard anything')

// ── Caddy ────────────────────────────────────────────────────────────────────────────────────
const caddy = readFileSync(join(root, 'deploy/caddy/Caddyfile'), 'utf8')
// Every matcher block, with the directive that introduces it: `handle_path` strips, `handle` does not.
const caddyBlocks = [...caddy.matchAll(/^\s*(handle_path|handle)\s+(\S+)\s*\{/gm)].map((m) => ({
  strips: m[1] === 'handle_path',
  matcher: m[2],
}))

for (const route of PROXIED_ROUTES) {
  // A prefix row needs the /* form; a row the client also opens bare needs the exact form too.
  const wanted = route.exact && route.path !== '/' ? [route.path] : []
  if (!route.exact) wanted.push(`${route.path}/*`)
  else if (route.ws || route.path === '/collab') wanted.push(`${route.path}/*`)
  for (const matcher of wanted) {
    const block = caddyBlocks.find((b) => b.matcher === matcher)
    if (!block) {
      problems.push(`Caddyfile: no block for "${matcher}" (${route.path} → ${route.upstream}). ${route.why}`)
      continue
    }
    if (block.strips !== route.strip) {
      problems.push(
        `Caddyfile: "${matcher}" uses ${block.strips ? 'handle_path (strips)' : 'handle (preserves)'} but the table says strip=${route.strip}. ` +
        'This column is the one that broke: the client sends /api/spaces and the server serves /spaces.',
      )
    }
  }
}
// Nothing routed that the table does not know.
const tablePrefixes = PROXIED_ROUTES.map((r) => r.path)
for (const block of caddyBlocks) {
  const bare = block.matcher.replace(/\/\*$/, '')
  if (!tablePrefixes.includes(bare)) {
    problems.push(`Caddyfile: "${block.matcher}" is routed but has no row in the table — add it there (with its reason) or remove the block`)
  }
}

// ── Kubernetes ingress ───────────────────────────────────────────────────────────────────────
// Comments are stripped FIRST. The first version of this check read the prose that explains
// rewrite-target as if it were the annotation, decided every Ingress stripped, and reported eleven
// failures that did not exist — the same shape as #693's lint reading an i18n string as code.
const ing = readFileSync(join(root, 'deploy/k8s/base/ingress.yaml'), 'utf8')
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
  .join('\n')
const ingPaths = [...ing.matchAll(/\{\s*path:\s*(\S+?),\s*pathType:\s*(\w+)/g)].map((m) => ({ path: m[1], type: m[2] }))
const stripObjects = ing.split(/^---$/m).filter((doc) => /rewrite-target:/.test(doc))
const strippedPaths = new Set(stripObjects.flatMap((doc) => [...doc.matchAll(/\{\s*path:\s*(\S+?),/g)].map((m) => m[1])))

// PER HOST, not per file. Every tenant is reached through the wildcard host, so a row present for
// the canonical host and missing for `*.wikistead.com` breaks every tenant while looking complete.
// The first version of this check asked only "does the path appear somewhere", and stayed green
// when /auth was deleted from one of the two hosts — a break-check caught it.
// Grouped BY HOST NAME across every Ingress object: /api lives in its own object (it is the one
// row that needs rewrite-target), so a per-block check would demand every route in every block.
// What must hold is that each host, taken as a whole, covers the table.
const byHost = new Map()
for (const m of ing.matchAll(/-\s*host:\s*(\S+)\n([\s\S]*?)(?=\n\s*-\s*host:|\n---|\s*$)/g)) {
  const host = m[1].replace(/"/g, '')
  const paths = [...m[2].matchAll(/\{\s*path:\s*(\S+?),\s*pathType:\s*(\w+)/g)].map((p) => p[1])
  byHost.set(host, [...(byHost.get(host) ?? []), ...paths])
}
const hostBlocks = [...byHost].map(([host, paths]) => ({ host, paths }))
if (hostBlocks.length === 0) problems.push('ingress.yaml: no host blocks parsed — the check would pass vacuously')
// The wildcard host is how every tenant is reached; losing it would break all of them while the
// canonical host still looked healthy.
if (!hostBlocks.some((b) => b.host.startsWith('*.'))) {
  problems.push('ingress.yaml: no wildcard tenant host — per-tenant subdomains would not resolve (ADR-016)')
}

for (const route of PROXIED_ROUTES) {
  for (const block of hostBlocks) {
    const hit = block.paths.find((p) => p === route.path || p === `${route.path}/(.*)`)
    if (!hit) {
      problems.push(`ingress.yaml (host ${block.host}): no path for ${route.path} (→ ${route.upstream}). ${route.why}`)
      continue
    }
    const stripped = strippedPaths.has(hit)
    if (stripped !== route.strip) {
      problems.push(
        `ingress.yaml (host ${block.host}): ${hit} is ${stripped ? 'in a rewrite-target Ingress (strips)' : 'in an Ingress that preserves the path'} ` +
        `but the table says strip=${route.strip}. rewrite-target applies per Ingress OBJECT, so a stripped row needs its own.`,
      )
    }
  }
}
const knownIngress = new Set([...tablePrefixes, '/', ...tablePrefixes.map((p) => `${p}/(.*)`)])
for (const p of ingPaths) {
  if (!knownIngress.has(p.path)) {
    problems.push(`ingress.yaml: ${p.path} is routed but has no row in the table — add it there or remove the rule`)
  }
}

// ── The SPA catch-all must exist on both, or a client route 404s ─────────────────────────────
if (!/^\s*handle\s*\{/m.test(caddy)) problems.push('Caddyfile: no fallback handle block — client routes would not reach the SPA')
if (!ingPaths.some((p) => p.path === '/')) problems.push('ingress.yaml: no "/" rule — client routes would not reach the SPA')

// ── Health endpoints are deliberately NOT edge rows ──────────────────────────────────────────
for (const h of NOT_EDGE_ROUTES) {
  if (caddyBlocks.some((b) => b.matcher.startsWith(h))) {
    problems.push(`Caddyfile: ${h} is an orchestrator probe hit pod-directly; routing it through the edge hides pod health behind the proxy`)
  }
}

if (problems.length) {
  console.error('check-origin-routes: the edge does not match the route table (#724 / ADR-231):')
  for (const p of problems) console.error('  ' + p)
  console.error('\nThe table is infra/routes/origin-routes.mjs. Every row says why it exists — read it before deleting one.')
  process.exit(1)
}
console.log(
  `check-origin-routes OK — ${ORIGIN_ROUTES.length} declared routes; Caddy and the ingress agree with the table ` +
  `(${PROXIED_ROUTES.filter((r) => r.strip).length} stripped, ${PROXIED_ROUTES.filter((r) => !r.strip).length} path-preserving).`,
)

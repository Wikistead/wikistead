// #407: the OpenAPI spec (docs/api/openapi.yaml) is HAND-MAINTAINED (the Fastify routes carry no JSON
// schemas to generate from), so this test is the anti-drift mechanism: it extracts EVERY route
// registration from the source tree and asserts each path is either documented in the spec or explicitly
// excluded below. Adding a member route without documenting it fails here — the spec can't silently rot.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const routesDir = join(here, '../routes')
const specPath = join(here, '../../../../docs/api/openapi.yaml')

// Route surfaces intentionally OUT of the REST spec (each has its own contract — see
// docs/api-reference.md "Coverage"). Prefix match.
const EXCLUDED_PREFIXES = [
  '/auth/', '/signup/',            // browser session flows (cookie BFF)
  '/admin/',                       // admin console API
  '/billing/', '/webhooks/stripe', // billing + Stripe receiver
  '/mcp',                          // MCP endpoints (documented via MCP itself)
  '/.well-known/',                 // OAuth metadata for MCP clients
  '/public/',                      // anonymous public reader
  '/pub/',                         // crawler-facing HTML shell (#409 / ADR-154 — not a JSON API)
  '/robots.txt', '/sitemap.xml',   // crawler surface (#408 / ADR-154 §2)
  '/healthz', '/readyz',           // infra probes
]
// Individual member routes deliberately not in the v1 spec (app-internal UI plumbing, not a stable
// integration surface). Reviewed additions only — do not grow this list as a dumping ground.
const EXCLUDED_PATHS = new Set([
  '/', // root
  '/pages/link-status',            // editor dead-link decoration feed (bulk, UI-shaped)
  '/pages/:pageId/title-dictionary', // editor auto-link dictionary (UI-shaped)
  '/pages/:pageId/embed',          // editor embed resolution (UI-shaped)
  '/pages/:pageId/plantuml/render', // editor diagram proxy
  '/templates/:id/plantuml/render', // editor diagram proxy (template preview)
  '/pages/:pageId/private', '/pages/:pageId/public', '/pages/:pageId/restrict', '/pages/:pageId/freeze', // permission dialog plumbing (grants API covers integration)
  '/spaces/:spaceId/access', '/spaces/:spaceId/public-access', '/spaces/:spaceId/comment-open', // space settings plumbing
  '/spaces/:spaceId/groups', '/spaces/:spaceId/member-candidates', '/spaces/:spaceId/pages-overview', // space settings plumbing
  '/spaces/:spaceId/branding', '/spaces/:spaceId/icon-image', '/branding', '/branding/logo', '/tenant/branding', '/tenant/branding/logo', // branding/UI
  '/me/settings', '/me/avatar', '/members/:sub', '/members/:sub/avatar-image', '/members/invites', '/members/invites/:id', // account/invite UI plumbing
  '/ai/ask', '/ai/capability',     // AI feature surface (own contract)
  '/pages/:pageId/mentionable',    // comment @-mention candidates (UI-shaped)
  '/pages/:pageId/member-candidates', // permissions-dialog member typeahead (UI-shaped; #416)
  '/pages/:pageId/tasks/toggle',   // read-surface checkbox flip (UI plumbing; publish covers integration)
  '/pages/:pageId/revisions/revert-actor', // moderation one-click revert (moderation UI surface)
  '/webhooks', '/webhooks/:id',    // admin-configured outbound webhooks (admin surface)
  '/audit', '/audit/verify', '/audit/export', // audit-log viewer (admin+entitlement surface, #401 / ADR-155)
])

function extractRoutes(): string[] {
  const files = readdirSync(routesDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  const out = new Set<string>()
  for (const f of files) {
    const src = readFileSync(join(routesDir, f), 'utf8')
    // Multiline-tolerant: app.<method><generics?>( ... '<path>' — the path may sit on the next line.
    const re = /app\.(get|post|put|patch|delete)\s*(?:<[^>]*(?:>[^(<]*)*?>)?\s*\(\s*\n?\s*'([^']+)'/g
    for (const m of src.matchAll(re)) out.add(m[2]!)
  }
  return [...out].sort()
}

describe('API inventory ↔ OpenAPI spec (#407 anti-drift)', () => {
  it('every route is documented in openapi.yaml or explicitly excluded', () => {
    const spec = readFileSync(specPath, 'utf8')
    // spec paths use {param}; source uses :param — normalize source → spec form
    const toSpecPath = (p: string) => p.replace(/:([A-Za-z]+)/g, '{$1}')
    const undocumented: string[] = []
    for (const route of extractRoutes()) {
      if (EXCLUDED_PREFIXES.some((pre) => route === pre || route.startsWith(pre))) continue
      if (EXCLUDED_PATHS.has(route)) continue
      const specForm = `  ${toSpecPath(route)}:`
      if (!spec.includes(specForm)) undocumented.push(route)
    }
    expect(undocumented, `routes missing from docs/api/openapi.yaml (document them or add a REVIEWED exclusion): ${undocumented.join(', ')}`).toEqual([])
  })

  it('every documented path still exists in the source (no dead spec entries)', () => {
    const spec = readFileSync(specPath, 'utf8')
    const routes = new Set(extractRoutes().map((p) => p.replace(/:([A-Za-z]+)/g, '{$1}')))
    const dead: string[] = []
    for (const m of spec.matchAll(/^  (\/[^\s:]*):$/gm)) {
      if (!routes.has(m[1]!)) dead.push(m[1]!)
    }
    expect(dead, `spec paths with no matching route: ${dead.join(', ')}`).toEqual([])
  })
})

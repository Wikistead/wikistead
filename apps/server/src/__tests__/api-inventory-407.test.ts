// #407: the OpenAPI spec (docs/api/openapi.yaml) is HAND-MAINTAINED (the Fastify routes carry no JSON
// schemas to generate from), so this test is the anti-drift mechanism: it extracts EVERY route
// registration from the source tree and asserts each path is either documented in the spec or explicitly
// excluded below. Adding a member route without documenting it fails here — the spec can't silently rot.
import { parse as parseYaml } from 'yaml' // #407 the spec must PARSE, not just string-match
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
  '/spaces/:spaceId/page-creation-policy', // page-creation-policy knob (#399; space settings plumbing)
  '/spaces/:spaceId/abuse-filter', // per-space moderation policy (#509; space settings plumbing)
  '/admin/roles', '/admin/roles/:roleId', '/admin/roles/tenant-defaults', // custom-role definitions + default presets (#420/#445; admin console plumbing)
  '/admin/roles/assignments', '/admin/roles/:roleId/assignments', '/admin/roles/assignments/:assignmentId', // role assignments (#420 inc3)
  '/spaces/:spaceId/branding', '/spaces/:spaceId/icon-image', '/branding', '/branding/logo', '/tenant/branding', '/tenant/branding/logo', // branding/UI
  '/me/settings', '/me/capabilities', '/me/avatar', '/members/:sub', '/members/:sub/avatar-image', '/members/invites', '/members/invites/:id', // account/invite UI plumbing
  '/ai/ask', '/ai/capability',     // AI feature surface (own contract)
  '/pages/:pageId/mentionable',    // comment @-mention candidates (UI-shaped)
  '/pages/:pageId/member-candidates', // permissions-dialog member typeahead (UI-shaped; #416)
  '/pages/:pageId/comment-audience', // permissions-dialog comment override (UI-shaped; #399)
  '/pages/:pageId/tasks/toggle',   // read-surface checkbox flip (UI plumbing; publish covers integration)
  '/pages/:pageId/revisions/revert-actor', // moderation one-click revert (moderation UI surface)
  '/me/activity',                  // personal contribution-heatmap feed (account UI-shaped; #483 / ADR-180)
  '/pages/:pageId/analytics', '/pages/:pageId/view', // page-analytics readout + view beacon (EE analytics UI plumbing; #464)
  '/tenant/abuse-filter',          // tenant-admin abuse-filter config (admin surface like /tenant/branding; #491)
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

  // #407 (review return): the two regex tests above guarantee COVERAGE but never parsed the
  // YAML — a broken spec (an unquoted description containing ": ") sailed through while Swagger UI could
  // not read it. This pins "the spec is valid YAML and minimally well-formed OpenAPI 3.1": parse +
  // structural asserts (openapi/info/paths present, every operation has responses).
  it('the spec parses as YAML and is minimally well-formed OpenAPI 3.1', () => {
    const doc = parseYaml(readFileSync(specPath, 'utf8')) as {
      openapi?: string
      info?: { title?: string; version?: string }
      paths?: Record<string, Record<string, { responses?: unknown }>>
    }
    expect(doc.openapi, 'openapi version field').toMatch(/^3\.1\./)
    expect(doc.info?.title, 'info.title').toBeTruthy()
    expect(doc.info?.version, 'info.version').toBeTruthy()
    expect(doc.paths && Object.keys(doc.paths).length, 'paths present').toBeGreaterThan(0)
    const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
    const missing: string[] = []
    for (const [path, ops] of Object.entries(doc.paths!)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!METHODS.has(method)) continue
        if (!op || typeof op !== 'object' || !('responses' in op) || !op.responses) missing.push(`${method.toUpperCase()} ${path}`)
      }
    }
    expect(missing, `operations without responses: ${missing.join(', ')}`).toEqual([])
  })

  // #407 (second review return, SAME bug class): the minimal structural assert above let a
  // flow-mapping description with unquoted commas through — "responses" existed, its CONTENT was phantom
  // OpenAPI keys. Only a real OpenAPI validator catches that, so run one: @redocly/openapi-core (what
  // redocly CLI runs), asserting ZERO error-severity problems (warnings — operationId etc. — are a
  // separate, non-blocking polish decision). Proven red against the breakage before the fix.
  it('the spec passes a real OpenAPI validator (redocly core) with zero errors', async () => {
    const { createConfig, lintFromString } = await import('@redocly/openapi-core')
    const config = await createConfig({ extends: ['minimal'] })
    const problems = await lintFromString({ source: readFileSync(specPath, 'utf8'), absoluteRef: specPath, config })
    const errors = problems.filter((p) => p.severity === 'error')
    expect(
      errors.map((e) => `${e.ruleId}: ${e.message} @ ${e.location?.[0]?.pointer ?? '?'}`),
      'redocly error-severity problems',
    ).toEqual([])
  })

  // #459 the polish pass (operationId / tags / 4xx / a shared default error) is invisible to the
  // validator above, which asserts error-severity only — operationId and friends are warnings, so the
  // whole pass could be reverted and every test here would stay green. That is how a finished spec rots:
  // the next route gets added without an operationId and nothing objects. These asserts are structural
  // rather than a redocly severity bump, so a failure names the offending operation instead of a rule id.
  it('every operation carries an operationId, tags, a 4xx and the shared error response (#459)', () => {
    const doc = parseYaml(readFileSync(specPath, 'utf8')) as Record<string, any>
    const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
    const ids = new Map<string, string>()
    const noId: string[] = []
    const noTags: string[] = []
    const no4xx: string[] = []
    const noDefault: string[] = []
    const dupes: string[] = []
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const [method, op] of Object.entries(item as Record<string, any>)) {
        if (!METHODS.has(method)) continue
        const where = `${method.toUpperCase()} ${path}`
        if (!op?.operationId) noId.push(where)
        else if (ids.has(op.operationId)) dupes.push(`${op.operationId} (${ids.get(op.operationId)} and ${where})`)
        else ids.set(op.operationId, where)
        if (!Array.isArray(op?.tags) || op.tags.length === 0) noTags.push(where)
        const codes = Object.keys(op?.responses ?? {})
        if (!codes.some((c) => /^4\d\d$/.test(c))) no4xx.push(where)
        if (op?.responses?.default?.$ref !== '#/components/responses/Error') noDefault.push(where)
      }
    }
    expect(noId, `operations without an operationId: ${noId.join(', ')}`).toEqual([])
    expect(dupes, `duplicate operationIds: ${dupes.join(', ')}`).toEqual([])
    expect(noTags, `operations without tags: ${noTags.join(', ')}`).toEqual([])
    expect(no4xx, `operations documenting no 4xx: ${no4xx.join(', ')}`).toEqual([])
    expect(noDefault, `operations not referencing the shared error response: ${noDefault.join(', ')}`).toEqual([])
    // and the tags the operations use must be declared at document level, so the reference renders grouped
    const declared = new Set((doc.tags ?? []).map((t: { name: string }) => t.name))
    const undeclared = [...new Set(Object.values(doc.paths ?? {}).flatMap((item: any) =>
      Object.entries(item as Record<string, any>).filter(([m]) => METHODS.has(m)).flatMap(([, op]) => op?.tags ?? []),
    ))].filter((t) => !declared.has(t))
    expect(undeclared, `tags used but not declared at document level: ${undeclared.join(', ')}`).toEqual([])
    // the license is part of the AGPL dual-licensing story (ADR-011), not cosmetics
    expect(doc.info?.license?.identifier ?? doc.info?.license?.name).toBe('AGPL-3.0-only')
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

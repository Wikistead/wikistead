// #409 / ADR-154: the public HTML SHELL — the crawler-facing first response for /pub URLs. NOT SSR
// (ADR-059's content deferral stands): the server returns the SPA's own built index.html with a
// per-page <head> block injected (robots, title, canonical — #408 adds og/twitter meta on this same
// seam), and the client hydrates into the existing public reader.
//
// Fortress rules (ADR-154 + theapproval):
// - Existence-hiding: the shell resolves the page/space through the SAME anonymous gate chain as the
//   public JSON routes (#253 tenant parent switch → ANON FGA view → published_at row gate). Absent /
//   unpublished / member-only / cross-tenant are all the SAME generic 404 shell (noindex only, no
//   title) — byte-identical, no cause distinction.
// - XSS: every injected string (title, host, id) passes escapeHtml — author content is interpolated
//   into HTML (anti-test: a <script> title renders escaped).
// - PUBLIC_SHELL_INDEX is FAIL-CLOSED: configured-but-unreadable refuses to boot; unset DISABLES the
//   shell entirely (the documented dev/prod split — vite serves /pub as plain SPA in dev; prod mounts
//   the web image's built index.html so the fingerprinted /assets/* resolve).
// - Responses are Cache-Control: no-store in v1 (correctness first;ruling b).
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { checkRelation, fgaClient } from '@wikistead/authz'
import { escapeHtml } from '@wikistead/macro-render'
import { withTenantTx } from '../db/index.js'
import { resolveTenantForRequest, tenantPublicEnabled, loadPublicPage } from './public.js'

const ANON = 'user:anonymous'

// Load the built SPA index.html the shell injects into. FAIL-CLOSED by contract: a configured path
// that cannot be read (or is not a plausible HTML document) throws — the server must not boot and
// silently serve a broken shell. Returns null when UNSET (dev: shell off by design).
export function loadShellTemplate(): string | null {
  const path = process.env.PUBLIC_SHELL_INDEX
  if (!path) return null
  const html = readFileSync(path, 'utf8') // throws on unreadable → boot failure (fail-closed)
  if (!html.includes('</head>')) {
    throw new Error(`PUBLIC_SHELL_INDEX (${path}) does not look like the built index.html (no </head>)`)
  }
  return html
}

// Pure head injection — exported for tests.
export function injectShellHead(template: string, head: string): string {
  return template.replace('</head>', `${head}</head>`)
}

export async function publicShellPlugin(app: FastifyInstance) {
  const template = loadShellTemplate()
  if (!template) return // dev/prod split: no built index.html configured → the shell is off (ADR-154 §1)

  const generic404 = injectShellHead(template, '<meta name="robots" content="noindex">')
  const send = (reply: import('fastify').FastifyReply, code: number, html: string) =>
    reply.code(code).header('cache-control', 'no-store').type('text/html; charset=utf-8').send(html)

  // The single-page public reader URL. Head carries: robots (page OR space noindex — the same OR the
  // JSON route computes), the escaped title, and the canonical URL.
  app.get<{ Params: { pageId: string } }>('/pub/:pageId', async (req, reply) => {
    const tenant = await resolveTenantForRequest(req.headers.host ?? '')
    if (!tenant) return send(reply, 404, generic404)
    if (!(await tenantPublicEnabled(tenant.id))) return send(reply, 404, generic404)
    if (!(await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: req.params.pageId }))) {
      return send(reply, 404, generic404)
    }
    const page = await loadPublicPage(tenant.id, req.params.pageId)
    if (!page) return send(reply, 404, generic404)

    const title = escapeHtml(page.title)
    const canonical = `https://${escapeHtml(req.headers.host ?? '')}/pub/${escapeHtml(page.id)}`
    let head = ''
    if (page.noindex) head += '<meta name="robots" content="noindex">'
    head += `<title>${title}</title><link rel="canonical" href="${canonical}">`
    return send(reply, 200, injectShellHead(template, head))
  })

  // The public-space reader URL. Space-level: title = space name; robots = the space's noindex
  // (public spaces are noindex-by-default per ADR-116 guardrail 4).
  app.get<{ Params: { spaceId: string } }>('/pub/space/:spaceId', async (req, reply) => {
    const tenant = await resolveTenantForRequest(req.headers.host ?? '')
    if (!tenant) return send(reply, 404, generic404)
    if (!(await tenantPublicEnabled(tenant.id))) return send(reply, 404, generic404)
    if (!(await checkRelation(fgaClient, ANON, 'viewer', { type: 'space', id: req.params.spaceId }))) {
      return send(reply, 404, generic404)
    }
    // Same-tenant row requirement (existence-hiding across tenants — the FGA store is shared).
    const spaceRow = await (withTenantTx(tenant.id, async (tx) => {
      const [r] = await tx<{ id: string; name: string; noindex: boolean }[]>`
        SELECT id, name, noindex FROM spaces WHERE id = ${req.params.spaceId}`
      return r ?? null
    }) as Promise<{ id: string; name: string; noindex: boolean } | null>)
    if (!spaceRow) return send(reply, 404, generic404)

    const title = escapeHtml(spaceRow.name)
    const canonical = `https://${escapeHtml(req.headers.host ?? '')}/pub/space/${escapeHtml(spaceRow.id)}`
    let head = ''
    if (spaceRow.noindex) head += '<meta name="robots" content="noindex">'
    head += `<title>${title}</title><link rel="canonical" href="${canonical}">`
    return send(reply, 200, injectShellHead(template, head))
  })
}

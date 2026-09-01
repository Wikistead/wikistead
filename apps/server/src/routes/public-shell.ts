// #409 / ADR-154: the public HTML SHELL — the crawler-facing first response for /pub URLs. NOT SSR
// (ADR-059's content deferral stands): the server returns the SPA's own built index.html with a
// per-page <head> block injected (robots, title, canonical — #408 adds og/twitter meta on this same
// seam), and the client hydrates into the existing public reader.
//
// Fortress rules (ADR-154 + the approval):
// - Existence-hiding: the shell resolves the page/space through the SAME anonymous gate chain as the
//   public JSON routes (#253 tenant parent switch → ANON FGA view → published_at row gate). Absent /
//   unpublished / member-only / cross-tenant are all the SAME generic 404 shell (noindex only, no
//   title) — byte-identical, no cause distinction.
// - XSS: every injected string (title, host, id) passes escapeHtml — author content is interpolated
//   into HTML (anti-test: a <script> title renders escaped).
// - PUBLIC_SHELL_INDEX is FAIL-CLOSED: configured-but-unreadable refuses to boot; unset DISABLES the
//   shell entirely (the documented dev/prod split — vite serves /pub as plain SPA in dev; prod mounts
//   the web image's built index.html so the fingerprinted /assets/* resolve).
// - Responses are Cache-Control: no-store in v1 (correctness first; ruling b).
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { checkRelation, fgaClient } from '@wikistead/authz'
import { escapeHtml } from '@wikistead/macro-render'
import { withTenantTx } from '../db/index.js'
import { resolveTenantForRequest, tenantPublicEnabled, loadPublicPage } from './public.js'

const ANON = 'user:anonymous'

// #408: a plain-text description from the PUBLISHED markdown (the loadPublicPage row — the
// must-fix: never getExcerpt, whose helper lacks the published_at gate). Cheap markdown-strip, first
// ~160 chars of prose; the caller escapes it.
export function descriptionFromMd(md: string | null): string {
  if (!md) return ''
  const text = md
    .replace(/^---\n[\s\S]*?\n---\n/, '')          // frontmatter
    .replace(/```[\s\S]*?```/g, ' ')                 // fenced code
    .replace(/^:{3,}[^\n]*$/gm, ' ')                  // directive markers
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // links → text
    .replace(/[#>*_`~|-]/g, ' ')                       // markdown punctuation
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

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

// #990 / ADR-277 §Decision item 3: the ONE surface where `frame-src` is a real second layer. The
// built index.html carries a meta CSP with `frame-src 'self' https:` (it cannot name a per-tenant
// value); this header, sent only by /pub/*, narrows that to the tenant's own embed allowlist
// (`tenant_settings.embed_providers`, ADR-071). A header CSP and a meta CSP are enforced as their
// intersection, so this cannot loosen anything the meta tag says — only tighten it.
//
// The allowlist is HOSTNAMES an administrator typed. Only a hostname-shaped entry reaches the header:
// a stray `;` or space would otherwise let a tenant admin write further directives into their own
// public pages' policy, and while that is their own surface, a header is not the place to find out.
// `isAllowlistedEmbed` (apps/web) accepts `host === h || host.endsWith('.' + h)`, hence the pair.
const EMBED_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
export function publicFrameSrc(providers: readonly string[]): string {
  const hosts = [...new Set(providers.map((h) => h.trim().toLowerCase().replace(/^\.+/, '')))].filter((h) => EMBED_HOST.test(h))
  const sources = hosts.flatMap((h) => [`https://${h}`, `https://*.${h}`])
  return `frame-src 'self'${sources.length ? ' ' + sources.join(' ') : ''}`
}

async function tenantEmbedProviders(tenantId: string): Promise<string[]> {
  return withTenantTx(tenantId, async (tx) => {
    const [row] = await tx<{ embed_providers: string[] | null }[]>`SELECT embed_providers FROM tenant_settings WHERE tenant_id = ${tenantId}`
    return row?.embed_providers ?? []
  }) as Promise<string[]>
}

export async function publicShellPlugin(app: FastifyInstance) {
  const template = loadShellTemplate()
  if (!template) return // dev/prod split: no built index.html configured → the shell is off (ADR-154 §1)

  const generic404 = injectShellHead(template, '<meta name="robots" content="noindex">')
  // Every shell response carries the per-tenant frame-src header (#990); the generic 404 carries the
  // bare `'self'`, since a 404 that named a tenant's allowlist would be an existence oracle.
  const send = (reply: import('fastify').FastifyReply, code: number, html: string, frameSrc = publicFrameSrc([])) =>
    reply.code(code).header('cache-control', 'no-store').header('content-security-policy', frameSrc).type('text/html; charset=utf-8').send(html)

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
    const description = escapeHtml(descriptionFromMd(page.published_md))
    let head = ''
    if (page.noindex) head += '<meta name="robots" content="noindex">'
    head += `<title>${title}</title><link rel="canonical" href="${canonical}">`
    // #408: OpenGraph/Twitter meta on the same seam. og:image is OUT of v1 (an image URL needs
    // safeHref-class scheme validation beyond escaping — ADR-154). Description comes from the SAME
    // published row the gate resolved — never a draft's text.
    head += `<meta property="og:title" content="${title}">`
    if (description) head += `<meta property="og:description" content="${description}"><meta name="description" content="${description}">`
    head += `<meta property="og:type" content="article"><meta property="og:url" content="${canonical}"><meta name="twitter:card" content="summary">`
    return send(reply, 200, injectShellHead(template, head), publicFrameSrc(await tenantEmbedProviders(tenant.id)))
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
    head += `<meta property="og:title" content="${title}"><meta property="og:type" content="website"><meta property="og:url" content="${canonical}"><meta name="twitter:card" content="summary">`
    return send(reply, 200, injectShellHead(template, head), publicFrameSrc(await tenantEmbedProviders(tenant.id)))
  })
}

// ── #408: robots.txt + sitemap.xml (ADR-154 §2) ──────────────────────────────
// Both respect the #253 tenant PARENT SWITCH: surface off ⇒ robots disallows everything and the
// sitemap is empty — a switched-off tenant leaks no URL list and invites no crawl. Registered
// UNCONDITIONALLY (unlike the shell, no built index.html is needed).
export async function publicRobotsPlugin(app: FastifyInstance) {
  app.get('/robots.txt', async (req, reply) => {
    reply.type('text/plain; charset=utf-8').header('cache-control', 'no-store')
    const tenant = await resolveTenantForRequest(req.headers.host ?? '')
    const enabled = tenant ? await tenantPublicEnabled(tenant.id) : false
    if (!enabled) return reply.send('User-agent: *\nDisallow: /\n')
    // /pub is the crawlable surface; /assets lets JS-executing crawlers render the body (ADR-154).
    return reply.send(
      `User-agent: *\nAllow: /pub/\nAllow: /assets/\nDisallow: /\n\nSitemap: https://${req.headers.host}/sitemap.xml\n`,
    )
  })

  app.get('/sitemap.xml', async (req, reply) => {
    reply.type('application/xml; charset=utf-8').header('cache-control', 'no-store')
    const empty = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'
    const tenant = await resolveTenantForRequest(req.headers.host ?? '')
    if (!tenant || !(await tenantPublicEnabled(tenant.id))) return reply.send(empty)
    // Candidates: PUBLISHED + INDEXABLE rows (gated in the SQL itself); each then confirmed as
    // anonymously viewable via FGA — a sitemap is an existence oracle BY DESIGN, so it lists exactly
    // what a crawler may index and nothing else (member-only/noindex/draft pages never appear).
    const rows = await (withTenantTx(tenant.id, async (tx) => {
      return tx<{ id: string; published_at: Date }[]>`
        SELECT p.id, p.published_at
        FROM pages p JOIN spaces s ON s.id = p.space_id
        WHERE p.published_at IS NOT NULL AND p.deleted_at IS NULL AND NOT (p.noindex OR s.noindex)
        ORDER BY p.published_at DESC
        LIMIT 5000
      `
    }) as Promise<{ id: string; published_at: Date }[]>)
    const urls: string[] = []
    for (const r of rows) {
      if (!(await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: r.id }))) continue
      urls.push(
        `<url><loc>https://${escapeHtml(req.headers.host ?? '')}/pub/${escapeHtml(r.id)}</loc><lastmod>${r.published_at.toISOString()}</lastmod></url>`,
      )
    }
    return reply.send(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`,
    )
  })
}

// Public render routes — no authentication required.
// These routes serve read-only snapshots of publicly accessible pages. They render
// the PUBLISHED version (pages.published_md), never the live draft — this is the
// most exposed surface (no auth at all), so reading the draft here would let anyone
// see in-progress, unpublished content.
// Collab WebSocket (Hocuspocus) is a completely separate path;
// anonymous visitors are NOT admitted to collaboration rooms here.
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { fgaClient, checkRelation } from '@wikistead/authz'
import { withTenantTx, acquireTenantDb } from '../db/index.js' // #382
import { resolveTenantFromHost, loadTenant } from '../tenant.js'
import { substituteListSnapshots, type ListSnapshot } from './pages.js' // #353→#370: baked `:::tagged`/`:::children` static lists for anon
import { downloadAttachment, inlineAttachment } from './attachments.js' // #376 / ADR-149 §2: public wrappers
import { resolveTranscludeRef } from '../transclude-resolve.js'
import { renderPlantuml } from '../plantuml-render.js'
import { bumpRateBucket, API_RATE_LIMIT_WINDOW_S } from '../rate-limit.js'
import { pool } from '../db/pool.js' // #464: durable analytics enqueue (analytics_outbox has no RLS)
import { collectPageView, hashAnonId, analyticsDayUTC } from '../analytics/collect.js' // #464 / ADR-175

// noindex: the page's own flag OR'd with its space's flag (#277 / ADR-116 guardrail 4) — a page
// reached via space inheritance is noindex if EITHER the page or its space says so.
export interface PublicPageRow { id: string; title: string; published_md: string | null; noindex: boolean; published_query_snapshot: string | null; space_id: string; space_name: string; space_icon_key: string | null }

// Anonymous principal for FGA check/listObjects.
// user:anonymous has NO tenant memberships, no groups, no explicit grants.
// The ONLY way it can view a page is via the user:* wildcard grant
// (page:X#view@user:*) or a public space (space:S#viewer@user:*).
// This is the ReBAC-correct representation of "any unauthenticated visitor".
// Semantics: user:* in GRANT tuples ≠ user:anonymous in CHECK calls.
const ANON = 'user:anonymous'

// ── helpers ───────────────────────────────────────────────────────────────

export async function resolveTenantForRequest(host: string) {
  const { slug, domain } = resolveTenantFromHost(host)
  return loadTenant(slug, domain)
}

// #253 / ADR-113 (guardrail 1 — the tenant PARENT SWITCH, read-time gate): the whole anonymous public
// surface is OFF unless the tenant admin turned it on (tenant_settings.public_enabled, default false). OFF ⇒
// every public route 404s uniformly (existence-hidden), WITHOUT touching any index or grant — non-destructive,
// so turning it back ON restores every public page (like the non-destructive billing freeze). The server is
// the fortress here: the hidden toggle UI is convenience; this gate is the guarantee.
export async function tenantPublicEnabled(tenantId: string): Promise<boolean> {
  return withTenantTx(tenantId, async (tx) => {
    const [r] = await tx<{ public_enabled: boolean }[]>`SELECT public_enabled FROM tenant_settings WHERE tenant_id = ${tenantId}`
    return r?.public_enabled === true
  }) as Promise<boolean>
}

// Read page from DB under RLS — tenant isolation is maintained even for public pages.
// #227: a page can carry the public grant (view_base@user:*) yet be UNPUBLISHED (published_at NULL)
// a draft that was toggled public, or public-before-publish. Its title/content/existence must NOT leak
// to anonymous visitors. Every public read here ALSO requires `published_at IS NOT NULL` (unpublished →
// treated as absent → 404), alongside the FGA view check. The public surface exposes only the PUBLISHED
// snapshot, never a draft's mere existence.
export async function loadPublicPage(tenantId: string, pageId: string): Promise<PublicPageRow | null> {
  return withTenantTx(tenantId, async (tx) => {
    const [r] = await tx<PublicPageRow[]>`
      SELECT p.id, p.title, p.published_md, (p.noindex OR s.noindex) AS noindex, p.published_query_snapshot,
             s.id AS space_id, s.name AS space_name, ss.icon_image_key AS space_icon_key
      FROM pages p JOIN spaces s ON s.id = p.space_id
      LEFT JOIN space_settings ss ON ss.space_id = s.id
      WHERE p.id = ${pageId} AND p.published_at IS NOT NULL
    `
    return r ?? null
  }) as Promise<PublicPageRow | null>
}

// Public child tree (ADR-030 / #26). A public page exposes its publicly-viewable
// descendants for navigation. NO inheritance: every node is individually FGA-checked with
// user:anonymous, and we never traverse INTO a non-public node — so a private page, and its
// whole subtree (reachable only through it), is excluded and never leaked. The result is a
// compact list of public pages only; sibling positions / indices are never exposed, so the
// presence of an omitted private sibling can't be inferred from a gap. Depth and fan-out are
// bounded so a deep/wide tree can't blow up the request.
export interface PublicChild { id: string; title: string; children: PublicChild[] }
const MAX_TREE_DEPTH = 6
const MAX_CHILDREN_PER_NODE = 200

async function loadDirectChildren(tenantId: string, parentId: string): Promise<{ id: string; title: string }[]> {
  return withTenantTx(tenantId, async (tx) => {
    return tx<{ id: string; title: string }[]>`
      SELECT id, title FROM pages WHERE parent_id = ${parentId}
        AND published_at IS NOT NULL
      ORDER BY position, created_at LIMIT ${MAX_CHILDREN_PER_NODE}
    `
  }) as Promise<{ id: string; title: string }[]>
}

// Recursively collect the public descendants of `parentId`. Each candidate child is
// individually authorized with ANON view; a non-public child is skipped AND not descended
// into (no path through a hidden node), so neither it nor anything below it leaks. Only
// confirmed-public nodes — and the gaps between them are not observable — are returned.
export async function loadPublicChildTree(
  tenantId: string,
  parentId: string,
  depth: number = MAX_TREE_DEPTH,
): Promise<PublicChild[]> {
  if (depth <= 0) return []
  const kids = await loadDirectChildren(tenantId, parentId)
  const out: PublicChild[] = []
  for (const k of kids) {
    const ok = await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: k.id })
    if (!ok) continue
    out.push({ id: k.id, title: k.title, children: await loadPublicChildTree(tenantId, k.id, depth - 1) })
  }
  return out
}

// #227 / ADR-030: the TOP-LEVEL public pages of a space (parent_id NULL, published). Each is then
// individually ANON-view-checked by the caller before it (and its public subtree) enters the tree — a
// non-public/unpublished root and its whole subtree never appear, with no observable gap.
async function loadPublicSpaceRoots(tenantId: string, spaceId: string): Promise<{ id: string; title: string }[]> {
  return withTenantTx(tenantId, async (tx) => {
    return tx<{ id: string; title: string }[]>`
      SELECT p.id, p.title FROM pages p JOIN spaces s ON s.id = p.space_id
      WHERE p.space_id = ${spaceId} AND p.parent_id IS NULL
        AND p.published_at IS NOT NULL
        -- #364 / ADR-157 §4: the home renders at the public space root too — skip it in the tree.
        AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
      ORDER BY p.position, p.created_at LIMIT ${MAX_CHILDREN_PER_NODE}
    `
  }) as Promise<{ id: string; title: string }[]>
}

// ── #376 / ADR-149 §2: public resource gates ─────────────────────────────
//
// Every /public/* RESOURCE route runs the SAME ordered gate before touching bytes
// tenant from Host → tenant public master switch (#253) → FGA ANON view on the OWNING page →
// `published_at IS NOT NULL` (LOAD-BEARING: the direct `user:*` public toggle carries no `published`
// requirement in the model, so ANON view alone would leak a public-toggled DRAFT's resources).
// Everything failing anywhere is a uniform 404 (existence-hiding). Returns the tenant, or null.
async function publicResourceGate(host: string, pageId: string): Promise<Awaited<ReturnType<typeof resolveTenantForRequest>>> {
  const tenant = await resolveTenantForRequest(host)
  if (!tenant) return null
  if (!(await tenantPublicEnabled(tenant.id))) return null
  if (!(await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: pageId }))) return null
  const rows = await withTenantTx(tenant.id, async (tx) =>
    tx<{ id: string }[]>`SELECT id FROM pages WHERE id = ${pageId} AND published_at IS NOT NULL`) as { id: string }[]
  if (!rows.length) return null
  return tenant
}

// #376: extract the ```plantuml fence BODIES from a published body — the membership set the public
// render route validates against (an anonymous caller may only render THIS page's own diagrams; any
// other source is refused before the Kroki fetch — the amplification guard). Tolerant of longer fences
// and an info-string tail (```plantuml align=left). Normalization (CR-strip + trailing-trim) matches
// the route's hash normalization.
export function extractPlantumlFences(md: string): string[] {
  const out: string[] = []
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})\s*plantuml\b/.exec(lines[i]!)
    if (!open) continue
    const fence = open[1]!
    const body: string[] = []
    let closed = false
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.startsWith(fence) && lines[j]!.trim() === fence) { i = j; closed = true; break }
      body.push(lines[j]!)
    }
    if (closed) out.push(body.join('\n'))
  }
  return out
}
const normalizeUml = (s: string) => s.replace(/\r/g, '').trimEnd()

// Abuse bounds for the anonymous render route (ADR-149 §2): the cache absorbs repeat views; on a miss,
// fixed-window buckets per tenant AND per client IP (this is a PRE-AUTH anonymous surface — IP keying is
// the sanctioned ADR-107 class here, unlike the authenticated abuse-filter keys of ADR-140).
const PUBLIC_RENDER_TENANT_MAX = 120
const PUBLIC_RENDER_IP_MAX = 30
const PUBLIC_RENDER_CACHE_TTL_S = 600

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function publicPlugin(app: FastifyInstance) {
  // GET /public/spaces/:spaceId/pages — the published+public page tree of a PUBLIC space (#227 / ADR-030),
  // for the anonymous read-only reader-chrome. The space must be anonymously viewable
  // (space:S#viewer@user:*) — else 404 (existence-hidden). Every node is individually ANON-view-checked
  // (loadPublicSpaceRoots + loadPublicChildTree) and published-gated, so an unpublished / non-public /
  // private page and its whole subtree never appear. No new authz — reuses the same per-node ANON check as
  // the page tree. principalForPage is untouched: this is a PUBLIC endpoint (no member routes for anon).
  app.get<{ Params: { spaceId: string } }>('/public/spaces/:spaceId/pages', async (req, reply) => {
    const tenant = await resolveTenantForRequest(req.headers.host ?? '')
    if (!tenant) return reply.code(404).send({ error: 'not found' })
    if (!(await tenantPublicEnabled(tenant.id))) return reply.code(404).send({ error: 'not found' }) // #253: tenant parent switch OFF ⇒ whole public surface hidden
    const spacePublic = await checkRelation(fgaClient, ANON, 'viewer', { type: 'space', id: req.params.spaceId })
    if (!spacePublic) return reply.code(404).send({ error: 'not found' })
    // The FGA viewer check is GLOBAL across the shared store; also require the space to belong to THIS
    // tenant (RLS) so a cross-tenant public-space UUID is a uniform 404 too — not a 200 empty tree that
    // confirms "this UUID is a public space somewhere" (existence-hiding, review note).
    const spaceRow = await withTenantTx(tenant.id, async (tx) => {
      const [r] = await tx<{ id: string; noindex: boolean }[]>`SELECT id, noindex FROM spaces WHERE id = ${req.params.spaceId}`
      return r ?? null
    }) as { id: string; noindex: boolean } | null
    if (!spaceRow) return reply.code(404).send({ error: 'not found' })
    // #277 / ADR-116 guardrail 4: a public space is noindex by default — emit the authoritative
    // X-Robots-Tag on the tree route (net-new; the single-page route OR's the space flag per page).
    if (spaceRow.noindex) reply.header('X-Robots-Tag', 'noindex')
    const roots = await loadPublicSpaceRoots(tenant.id, req.params.spaceId)
    const tree: PublicChild[] = []
    for (const r of roots) {
      if (!(await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: r.id }))) continue
      tree.push({ id: r.id, title: r.title, children: await loadPublicChildTree(tenant.id, r.id) })
    }
    // #364 / ADR-157 §5: the space HOME rides the same response (rendered at the public space root).
    // Same anon gates as every tree node: published (the RLS query) + ANON view. Response stays
    // backward-tolerant: the shell accepts both the legacy array and the {home, tree} object.
    const homeRow = await withTenantTx(tenant.id, async (tx) => {
      const [r] = await tx<{ id: string; title: string }[]>`
        SELECT p.id, p.title FROM pages p JOIN spaces s ON s.id = p.space_id
        WHERE s.id = ${req.params.spaceId} AND p.id = s.home_page_id
          AND p.published_at IS NOT NULL AND p.deleted_at IS NULL`
      return r ?? null
    }) as { id: string; title: string } | null
    const home = homeRow && (await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: homeRow.id }))
      ? { id: homeRow.id, title: homeRow.title }
      : null
    return reply.send({ home, tree })
  })

  // GET /public/pages/:pageId — single public page read-only render
  app.get<{ Params: { pageId: string } }>('/public/pages/:pageId', async (req, reply) => {
    const tenant = await resolveTenantForRequest(req.headers.host ?? '')
    if (!tenant) return reply.code(404).send({ error: 'not found' })
    if (!(await tenantPublicEnabled(tenant.id))) return reply.code(404).send({ error: 'not found' }) // #253: tenant parent switch OFF ⇒ whole public surface hidden

    // Public check via user:anonymous (not user:*).
    // Returns true if page:X#view@user:* exists OR space:S#viewer@user:* applies.
    // 404 (not 403): avoids leaking the existence of private pages to probes.
    const isPublic = await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: req.params.pageId })
    if (!isPublic) return reply.code(404).send({ error: 'not found' })

    const page = await loadPublicPage(tenant.id, req.params.pageId)
    if (!page) return reply.code(404).send({ error: 'not found' })

    // #353→#370 / ADR-145: substitute each `:::tagged`/`:::children` directive with its baked ANONYMOUS static list
    // (resolved as user:anonymous at publish — member-only pages already excluded). The public surface renders a
    // static list, NEVER a live per-viewer reverse-lookup (the #244 re-entry class). A missing/mismatched
    // snapshot collapses the block to nothing (fail-safe inside substituteListSnapshots).
    const snapshot = page.published_query_snapshot ? (JSON.parse(page.published_query_snapshot) as ListSnapshot) : null
    const content = substituteListSnapshots(page.published_md ?? '', snapshot)

    // noindex enforcement (#124): emit the HTTP X-Robots-Tag header so a crawler that fetches
    // this page is told not to index it — the header is authoritative even before any HTML/SSR
    // layer exists, and the reverse proxy (#125) forwards it as-is. The `noindex` field is
    // ALSO returned so the SPA can mirror it as <meta name="robots"> for the rendered page.
    if (page.noindex) reply.header('X-Robots-Tag', 'noindex')
    //
    // Public child tree: each child is individually checked (loadPublicChildTree) — a
    // public parent does NOT make its children public, and non-public children (and their
    // subtrees) are excluded with no observable gap.
    //
    // Explicitly NOT included: viewerUsers/viewerGroups (internal ACL),
    // created_by (would leak user IDs), revision history,
    // attachment presigned URLs, non-public children.
    // #464 / ADR-175: count this ANONYMOUS public read for page analytics — entitled tenants only
    // (collection is itself EE-gated), deduped per-IP/page/day (a floor: NAT collapses distinct readers),
    // the IP hashed and never stored. AFTER the public view gate above, so existence-hiding is intact and
    // only a genuinely public page is ever recorded. await+catch: durable enqueue, but a collection hiccup
    // (Valkey/DB) never fails the read.
    await collectPageView({
      sql: pool, valkey: app.valkey, tenant: { id: tenant.id, plan: tenant.plan },
      pageId: page.id, viewerClass: 'anon', memberSub: null,
      dedupKey: hashAnonId(req.ip), day: analyticsDayUTC(new Date()),
    }).catch(() => {})

    const children = await loadPublicChildTree(tenant.id, page.id)
    // #430the reader's header shows WHICH space this page belongs to (name + icon), so the
    // standalone /pub view is never a nameless slab. Both are labels attached to a page the caller is
    // already allowed to read in full, and the icon bytes are served by the existing public route.
    return reply.send({
      id: page.id,
      title: page.title,
      content,
      noindex: page.noindex,
      children,
      space: {
        name: page.space_name,
        iconImageUrl: page.space_icon_key ? `/spaces/${page.space_id}/icon-image` : null,
      },
    })
  })

  // GET /public/pages — list all public pages in the current tenant.
  // Uses FGA list_objects with user:anonymous, then filters by tenant via RLS.
  app.get('/public/pages', async (req, reply) => {
    const tenant = await resolveTenantForRequest(req.headers.host ?? '')
    if (!tenant) return reply.code(404).send({ error: 'not found' })
    if (!(await tenantPublicEnabled(tenant.id))) return reply.code(404).send({ error: 'not found' }) // #253: tenant parent switch OFF ⇒ whole public surface hidden

    // list_objects returns public page IDs across the entire shared FGA store.
    // RLS (withTenant) then narrows to this tenant's pages only.
    // Same anonymous principal as single-page check for consistency.
    const { objects } = await fgaClient.listObjects({
      user: ANON,
      relation: 'view',
      type: 'page',
    })
    const pageIds = (objects ?? []).map((o: string) => o.replace(/^page:/, ''))
    if (pageIds.length === 0) return reply.send([])

    const pages = await withTenantTx(tenant.id, async (tx) => {
      return tx<{ id: string; title: string }[]>`
        SELECT id, title FROM pages
        WHERE id = ANY(${pageIds})
          AND published_at IS NOT NULL
        ORDER BY created_at DESC
      `
    }) as { id: string; title: string }[]

    return reply.send(pages)
  })

  // ── #376 / ADR-149 §2: PUBLIC resource resolvers (anonymous; wrappers over the shared services) ──

  // The attachment routes: resolve the attachment's OWNING page under tenant RLS (a cross-tenant id is
  // a DB no-row → uniform 404, matching the public space route), run the ordered public gate on that
  // page, then call the SHARED service with subject = user:anonymous (which re-runs its own view gate
  // defense-in-depth; the member/guest routes are untouched).
  const publicAttachmentPage = async (tenantId: string, attId: string): Promise<string | null> => {
    const rows = await withTenantTx(tenantId, async (tx) =>
      tx<{ page_id: string }[]>`SELECT page_id FROM attachments WHERE id = ${attId}`) as { page_id: string }[]
    return rows[0]?.page_id ?? null
  }

  app.get<{ Params: { id: string } }>('/public/attachments/:id/download', async (req, reply) => {
    const tenant = await resolveTenantForRequest(req.headers.host ?? '')
    if (!tenant) return reply.code(404).send({ error: 'not found' })
    if (!(await tenantPublicEnabled(tenant.id))) return reply.code(404).send({ error: 'not found' })
    const pageId = await publicAttachmentPage(tenant.id, req.params.id)
    if (!pageId || !(await publicResourceGate(req.headers.host ?? '', pageId))) return reply.code(404).send({ error: 'not found' })
    const db = await acquireTenantDb(tenant)
    try {
      const result = await downloadAttachment(db, app.storageDriver, app.fga, { id: req.params.id, subject: ANON })
      return reply.send(result)
    } finally { await db.release() }
  })

  app.get<{ Params: { id: string } }>('/public/attachments/:id/inline', async (req, reply) => {
    const tenant = await resolveTenantForRequest(req.headers.host ?? '')
    if (!tenant) return reply.code(404).send({ error: 'not found' })
    if (!(await tenantPublicEnabled(tenant.id))) return reply.code(404).send({ error: 'not found' })
    const pageId = await publicAttachmentPage(tenant.id, req.params.id)
    if (!pageId || !(await publicResourceGate(req.headers.host ?? '', pageId))) return reply.code(404).send({ error: 'not found' })
    const db = await acquireTenantDb(tenant)
    try {
      const { bytes, contentType, filename } = await inlineAttachment(db, app.storageDriver, app.fga, { id: req.params.id, subject: ANON })
      // The SAME XSS boundary headers as the member/guest inline proxy (ADR-120): sniffed type,
      // inline disposition, nosniff, no-execute CSP — kept on the public path too (ADR-149).
      reply.header('Content-Type', contentType)
      reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`)
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Content-Security-Policy', "default-src 'none'; object-src 'none'; script-src 'none'")
      reply.header('Cache-Control', 'public, max-age=300') // public bytes — cacheable briefly (unlike the member proxy)
      return reply.send(Buffer.from(bytes))
    } finally { await db.release() }
  })

  // POST /public/pages/:pageId/plantuml/render — the anonymous server-render seam, abuse-bounded.
  // Gate ORDER (ADR-149, fixed): tenant switch → ANON view → published → SOURCE-MEMBERSHIP (the sent
  // source must hash-match a ```plantuml fence in THIS page's published_md — refused 400 BEFORE any
  // Kroki fetch; drift-free, blocks arbitrary-source amplification) → cache lookup → on miss,
  // per-tenant + per-IP fixed-window rate limit → Kroki. theme is the dark/light flag ONLY and is part
  // of the cache key. SSRF stays closed (operator-fixed Kroki URL, #341).
  app.post<{ Params: { pageId: string }; Body: { source?: string; theme?: string } }>('/public/pages/:pageId/plantuml/render', async (req, reply) => {
    const tenant = await publicResourceGate(req.headers.host ?? '', req.params.pageId)
    if (!tenant) return reply.code(404).send({ error: 'not found' })
    const source = req.body?.source
    if (typeof source !== 'string' || !source.trim()) return reply.code(400).send({ error: 'source is required' })
    const rows = await withTenantTx(tenant.id, async (tx) =>
      tx<{ published_md: string | null }[]>`SELECT published_md FROM pages WHERE id = ${req.params.pageId}`) as { published_md: string | null }[]
    const fences = extractPlantumlFences(rows[0]?.published_md ?? '')
    const sent = normalizeUml(source)
    if (!fences.some((f) => normalizeUml(f) === sent)) {
      return reply.code(400).send({ error: 'source is not a diagram of this page' }) // static reason; pre-fetch refusal
    }
    const dark = req.body?.theme === 'dark'
    const cacheKey = `pub:uml:${tenant.id}:${createHash('sha256').update(sent).update(dark ? '|d' : '|l').digest('hex')}`
    const hit = await app.valkey.getBuffer(cacheKey).catch(() => null)
    if (hit && hit.length) return reply.header('content-type', 'image/png').send(hit)
    const okTenant = await bumpRateBucket(app.valkey, `rl:pubuml:t:${tenant.id}`, PUBLIC_RENDER_TENANT_MAX, API_RATE_LIMIT_WINDOW_S)
    const okIp = await bumpRateBucket(app.valkey, `rl:pubuml:ip:${req.ip}`, PUBLIC_RENDER_IP_MAX, API_RATE_LIMIT_WINDOW_S)
    if (!okTenant || !okIp) return reply.code(429).send({ error: 'rate limited' })
    const png = await renderPlantuml(source, { dark })
    if (!png) return reply.code(204).send() // degrade: the caller keeps the source fence
    void app.valkey.set(cacheKey, Buffer.from(png), 'EX', PUBLIC_RENDER_CACHE_TTL_S).catch(() => {})
    return reply.header('content-type', 'image/png').send(png)
  })

  // GET /public/pages/:pageId/transclude/:refId — anonymous transclusion. The REF page resolves through
  // ITS OWN gate inside resolveTranscludeRef (view as user:anonymous + published; unviewable ≡
  // unpublished ≡ absent = one uniform 'denied' → 404 — the #307 public-surface existence-hiding class).
  // Depth/cycle guard on the public mount is CLIENT-structural (the transcluded content renders via
  // renderMarkdownToDom, which never fetches nested embeds — pinned by the unit anti-test).
  app.get<{ Params: { pageId: string; refId: string } }>('/public/pages/:pageId/transclude/:refId', async (req, reply) => {
    const tenant = await publicResourceGate(req.headers.host ?? '', req.params.pageId)
    if (!tenant) return reply.code(404).send({ error: 'not found' })
    const db = await acquireTenantDb(tenant)
    try {
      const r = await resolveTranscludeRef({ db, fga: app.fga }, { principal: ANON, refPageId: req.params.refId })
      if (r.ok) return { content: r.content }
      return reply.code(r.reason === 'denied' ? 404 : 422).send({ error: 'transclude not available', reason: r.reason })
    } finally { await db.release() }
  })
}

// Public render routes — no authentication required.
// These routes serve read-only snapshots of publicly accessible pages. They render
// the PUBLISHED version (pages.published_md), never the live draft — this is the
// most exposed surface (no auth at all), so reading the draft here would let anyone
// see in-progress, unpublished content.
// Collab WebSocket (Hocuspocus) is a completely separate path;
// anonymous visitors are NOT admitted to collaboration rooms here.
import type { FastifyInstance } from 'fastify'
import { fgaClient, checkRelation } from '@wikistead/authz'
import { withTenantTx } from '../db/index.js' // #382
import { resolveTenantFromHost, loadTenant } from '../tenant.js'
import { substituteListSnapshots, type ListSnapshot } from './pages.js' // #353→#370: baked `:::tagged`/`:::children` static lists for anon

// noindex: the page's own flag OR'd with its space's flag (#277 / ADR-116 guardrail 4) — a page
// reached via space inheritance is noindex if EITHER the page or its space says so.
interface PublicPageRow { id: string; title: string; published_md: string | null; noindex: boolean; published_query_snapshot: string | null }

// Anonymous principal for FGA check/listObjects.
// user:anonymous has NO tenant memberships, no groups, no explicit grants.
// The ONLY way it can view a page is via the user:* wildcard grant
// (page:X#view@user:*) or a public space (space:S#viewer@user:*).
// This is the ReBAC-correct representation of "any unauthenticated visitor".
// Semantics: user:* in GRANT tuples ≠ user:anonymous in CHECK calls.
const ANON = 'user:anonymous'

// ── helpers ───────────────────────────────────────────────────────────────

async function resolveTenantForRequest(host: string) {
  const { slug, domain } = resolveTenantFromHost(host)
  return loadTenant(slug, domain)
}

// #253 / ADR-113 (guardrail 1 — the tenant PARENT SWITCH, read-time gate): the whole anonymous public
// surface is OFF unless the tenant admin turned it on (tenant_settings.public_enabled, default false). OFF ⇒
// every public route 404s uniformly (existence-hidden), WITHOUT touching any index or grant — non-destructive,
// so turning it back ON restores every public page (like the non-destructive billing freeze). The server is
// the fortress here: the hidden toggle UI is convenience; this gate is the guarantee.
async function tenantPublicEnabled(tenantId: string): Promise<boolean> {
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
async function loadPublicPage(tenantId: string, pageId: string): Promise<PublicPageRow | null> {
  return withTenantTx(tenantId, async (tx) => {
    const [r] = await tx<PublicPageRow[]>`
      SELECT p.id, p.title, p.published_md, (p.noindex OR s.noindex) AS noindex, p.published_query_snapshot
      FROM pages p JOIN spaces s ON s.id = p.space_id
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
      SELECT id, title FROM pages WHERE space_id = ${spaceId} AND parent_id IS NULL
        AND published_at IS NOT NULL
      ORDER BY position, created_at LIMIT ${MAX_CHILDREN_PER_NODE}
    `
  }) as Promise<{ id: string; title: string }[]>
}

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
    return reply.send(tree)
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
    const children = await loadPublicChildTree(tenant.id, page.id)
    return reply.send({
      id: page.id,
      title: page.title,
      content,
      noindex: page.noindex,
      children,
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
}

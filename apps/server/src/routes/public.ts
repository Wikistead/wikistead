// Public render routes — no authentication required.
// These routes serve read-only snapshots of publicly accessible pages.
// Collab WebSocket (Hocuspocus) is a completely separate path;
// anonymous visitors are NOT admitted to collaboration rooms here.
import * as Y from 'yjs'
import type { FastifyInstance } from 'fastify'
import { fgaClient, checkRelation } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { resolveTenantFromHost, loadTenant } from '../tenant.js'

interface PublicPageRow { id: string; title: string; ydoc: Buffer | null; noindex: boolean }

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

// Read page from DB under RLS — tenant isolation is maintained even for public pages.
async function loadPublicPage(tenantId: string, pageId: string): Promise<PublicPageRow | null> {
  return pool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    const [r] = await tx<PublicPageRow[]>`
      SELECT id, title, ydoc, noindex FROM pages WHERE id = ${pageId}
    `
    return r ?? null
  }) as Promise<PublicPageRow | null>
}

function decodeYdoc(ydoc: Buffer | null): string {
  if (!ydoc) return ''
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(ydoc))
  return doc.getText('content').toString()
}

// ── Fastify plugin ────────────────────────────────────────────────────────

export async function publicPlugin(app: FastifyInstance) {
  // GET /public/pages/:pageId — single public page read-only render
  app.get<{ Params: { pageId: string } }>('/public/pages/:pageId', async (req, reply) => {
    const tenant = await resolveTenantForRequest(req.headers.host ?? '')
    if (!tenant) return reply.code(404).send({ error: 'not found' })

    // Public check via user:anonymous (not user:*).
    // Returns true if page:X#view@user:* exists OR space:S#viewer@user:* applies.
    // 404 (not 403): avoids leaking the existence of private pages to probes.
    const isPublic = await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: req.params.pageId })
    if (!isPublic) return reply.code(404).send({ error: 'not found' })

    const page = await loadPublicPage(tenant.id, req.params.pageId)
    if (!page) return reply.code(404).send({ error: 'not found' })

    const content = decodeYdoc(page.ydoc)

    // TODO(phase: public-html): noindex enforcement (X-Robots-Tag header) belongs
    // in the HTML rendering layer that crawlers actually visit, not here.
    // The noindex field is returned so the client can set <meta name="robots">.
    //
    // TODO(phase: public-html): when parent_id is wired, each child page must be
    // individually checked: checkRelation(ANON, 'view', child) before inclusion.
    // A public parent does NOT automatically make children public.
    //
    // Explicitly NOT included: viewerUsers/viewerGroups (internal ACL),
    // created_by (would leak user IDs), revision history,
    // attachment presigned URLs, non-public children.
    return reply.send({
      id: page.id,
      title: page.title,
      content,
      noindex: page.noindex,
    })
  })

  // GET /public/pages — list all public pages in the current tenant.
  // Uses FGA list_objects with user:anonymous, then filters by tenant via RLS.
  app.get('/public/pages', async (req, reply) => {
    const tenant = await resolveTenantForRequest(req.headers.host ?? '')
    if (!tenant) return reply.code(404).send({ error: 'not found' })

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

    const pages = await pool.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
      return tx<{ id: string; title: string }[]>`
        SELECT id, title FROM pages
        WHERE id = ANY(${pageIds})
        ORDER BY created_at DESC
      `
    }) as { id: string; title: string }[]

    return reply.send(pages)
  })
}

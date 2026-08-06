import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { filterAuthorized, check } from '@wikistead/authz'
import { renderMcpSyntaxSections } from '@wikistead/macro-render'
import { resolveEntitlements } from '@wikistead/entitlements'
import { docName } from '@wikistead/types'
import { getPublished, listPages, getBacklinks, createPage, publishPage } from './pages.js'
import { listAllSpaces } from './spaces.js'
import { createPageComment } from './comments.js'
import { mcpEditDraft, CollabUnavailableError } from '../collab-mcpedit.js'
import { fillAuthorizedPage, SEARCH_CANDIDATE_LIMIT } from '../search/paginate.js'
import { authenticateMcpRequest, type McpPrincipal } from '../auth/mcp-request-auth.js'
import { productName } from '../product-name.js' // #575: the syntax reference names the deployment

// #369 / ADR-144: an edit_body body is a DRAFT edit, not a bulk import — cap it (defense-in-depth; the size
// travels to the pod which re-enforces it). 256k chars is ample for a page body and refuses an abusive payload.
const MAX_EDIT_BODY_CHARS = 256_000

// #311 / ADR-131 slice 5: the MCP endpoint — a minimal Streamable-HTTP (JSON-RPC 2.0 over POST) transport with a
// READ-first tool surface (v1). Every request is Bearer-authenticated (slice 4 token) + tenant-bound
// (authenticateMcpRequest); each tool is a THIN BROKER over an existing service fn called as `user:<sub>`, so
// OpenFGA is re-checked per operation and a view-denied resource is the SAME uniform not-found as a missing one
// (existence-hiding). The tool holds no db/fga handle beyond what the host passes — the ADR-075 broker rule.
// This slice ships ONE read tool (get_page); more (search / list spaces / tree / backlinks) are additive.

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'wikistead', version: '0.1.0' }

// #373 → #447 / ADR-172: the Wikistead authoring-syntax reference a connected LLM reads before writing
// page/comment bodies, so it uses the real notation instead of guessing. Wikistead is Open-formats first
// (CommonMark / GFM), and its macros are standard-ish `:::` directives / fenced code — everything
// round-trips to plain Markdown. This is PUBLIC spec info (no authz), served through the same
// authenticated tool surface. The per-macro sections GENERATE from the shared manifest in
// @wikistead/macro-render (MCP_SYNTAX_MANIFEST); the editor-side lock-step test pins that manifest to
// the macro registry, so a new first-party macro cannot ship without its syntax entry (the
// exportFidelity pattern). Only the curated FORMAT prose below stays hand-written — it documents
// CommonMark/frontmatter/inline marks, not macros.
const SYNTAX_PREAMBLE = `# ${productName()} authoring syntax

Bodies are **CommonMark + GitHub-Flavored Markdown** (headings, **bold**, *italic*, \`code\`, lists, tables,
task lists \`- [ ]\`, links \`[text](/p/<pageId>)\` for internal pages). On top of that, these macros are available
(all are plain-text \`:::\` directives or fenced code — they round-trip losslessly to Markdown):`

const SYNTAX_TAIL = `## Tags (frontmatter)
A page's tags live in a leading YAML frontmatter block (first line of the document):
\`\`\`
---
tags: [recipes, dinner]
---
\`\`\`
Tags are plain strings (case-insensitive); no inline #tag notation exists.

## Inline
- Highlight: \`==highlighted==\`
- Footnotes: a reference \`[^1]\` and a definition line \`[^1]: the note\`.
- Math: \`$$ … $$\` (block).

Prefer plain CommonMark/GFM where it suffices; reach for a macro only when you need its behavior. Never invent
notation not listed here.`

const SYNTAX_REFERENCE = `${SYNTAX_PREAMBLE}\n\n${renderMcpSyntaxSections()}\n\n${SYNTAX_TAIL}`

// The v1 read tool set. Each declares its required scope (read/write ceiling) and a thin broker.
interface McpTool {
  name: string
  description: string
  scope: 'read' | 'write'
  inputSchema: Record<string, unknown>
  run: (req: FastifyRequest, app: FastifyInstance, principal: McpPrincipal, args: Record<string, unknown>) => Promise<string>
}

const TOOLS: McpTool[] = [
  {
    name: 'get_page',
    description: "Fetch a page's title and published Markdown by id. Returns not-found if the page doesn't exist or you cannot view it.",
    scope: 'read',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string', description: 'the page id' } }, required: ['pageId'] },
    async run(req, app, principal, args) {
      const pageId = typeof args.pageId === 'string' ? args.pageId : ''
      if (!pageId) throw toolError('pageId is required')
      // Thin broker: getPublished re-checks FGA `view` on user:<sub> and throws a uniform 404 when denied OR
      // missing (existence-hiding). We surface that as a plain not-found tool error — never a distinguishable
      // "forbidden".
      let page
      try {
        page = await getPublished(req.db, app.fga, { pageId, subject: `user:${principal.sub}` })
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 404) throw toolError('page not found')
        throw e
      }
      return `# ${page.title}\n\n${page.publishedMd ?? '(no published content)'}`
    },
  },
  {
    name: 'list_spaces',
    description: 'List the spaces you can access (id + name).',
    scope: 'read',
    inputSchema: { type: 'object', properties: {} },
    async run(req, app, principal) {
      // Thin broker: listAllSpaces returns only the view-authorized spaces for this member.
      //
      // #623 slice 12b: the listing pages now, and this tool answers "what spaces are there", so it
      // walks all of them through the shared helper rather than writing the loop a second time.
      const spaces = await listAllSpaces(req.db, app.fga, principal.sub)
      if (!spaces.length) return 'no accessible spaces'
      return spaces.map((s) => `- ${s.name} (${s.id})`).join('\n')
    },
  },
  {
    name: 'list_pages',
    description: 'List the pages in a space that you can view (id + title). Returns none if the space is empty or not visible to you.',
    scope: 'read',
    inputSchema: { type: 'object', properties: { spaceId: { type: 'string', description: 'the space id' } }, required: ['spaceId'] },
    async run(req, app, principal, args) {
      const spaceId = typeof args.spaceId === 'string' ? args.spaceId : ''
      if (!spaceId) throw toolError('spaceId is required')
      // listPages FGA-view-filters per page (a non-viewable space yields an empty list — no existence oracle).
      const pages = await listPages(req.db, app.fga, { spaceId, subject: `user:${principal.sub}` })
      if (!pages.length) return 'no visible pages'
      return pages.map((p) => `- ${p.title} (${p.id})`).join('\n')
    },
  },
  {
    name: 'get_backlinks',
    description: 'List the pages that link to a given page (id + title). Returns not-found if you cannot view the target page.',
    scope: 'read',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string', description: 'the target page id' } }, required: ['pageId'] },
    async run(req, app, principal, args) {
      const pageId = typeof args.pageId === 'string' ? args.pageId : ''
      if (!pageId) throw toolError('pageId is required')
      // getBacklinks view-gates the TARGET (uniform 404 when denied/missing) then FGA-view-confirms each source.
      let links
      try {
        links = await getBacklinks(req.db, app.fga, { pageId, subject: `user:${principal.sub}` })
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 404) throw toolError('page not found')
        throw e
      }
      if (!links.length) return 'no backlinks'
      return links.map((l) => `- ${l.title} (${l.id})`).join('\n')
    },
  },
  {
    name: 'search',
    description: 'Full-text search across pages you can view (returns the top matches: id + title).',
    scope: 'read',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'the search query' } }, required: ['query'] },
    async run(req, app, principal, args) {
      const q = typeof args.query === 'string' ? args.query.trim() : ''
      if (!q) throw toolError('query is required')
      // The SAME two-stage gate as GET /search: Meili stage-1 (denormalized viewer set — needs the member's
      // groups, carried on the token) THEN stage-2 filterAuthorized FGA on the candidates (authoritative). One
      // page (no cursor) for the tool. A view-denied hit never survives stage-2.
      const { results } = await fillAuthorizedPage(
        (offset, limit) => app.searchDriver.search({ tenantId: principal.tenantId, userId: principal.sub, groups: principal.groups, q, offset, limit }),
        (ids) => filterAuthorized(app.fga, `user:${principal.sub}`, 'view', ids),
        { startOffset: 0, windowSize: SEARCH_CANDIDATE_LIMIT },
      )
      if (!results.length) return 'no results'
      return results.map((r) => `- ${r.title} (${r.id})`).join('\n')
    },
  },
  {
    name: 'get_syntax_reference',
    description: 'Get the Wikistead authoring-syntax reference (CommonMark/GFM + the supported `:::` macros and fenced diagrams). Call this before writing a page or comment body so you use the real notation.',
    scope: 'read',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      // Static PUBLIC spec — no db/authz needed (still behind the authenticated tool surface).
      return SYNTAX_REFERENCE
    },
  },
  {
    name: 'create_page',
    description: 'Create a new draft page in a space (requires edit access to the space). Returns the new page id.',
    scope: 'write',
    inputSchema: { type: 'object', properties: { spaceId: { type: 'string' }, title: { type: 'string' } }, required: ['spaceId'] },
    async run(req, app, principal, args) {
      const spaceId = typeof args.spaceId === 'string' ? args.spaceId : ''
      if (!spaceId) throw toolError('spaceId is required')
      const title = typeof args.title === 'string' ? args.title : undefined
      // Thin broker: createPage gates the destination space with FGA `edit` FIRST (403 for a non-editor). The
      // draft is creator-only until published (ADR phase-4 visibility). We report a uniform "cannot create here"
      // for a denied space (no distinction from a missing one).
      try {
        const page = await createPage(req.db, app.fga, app.searchDriver, { tenantId: principal.tenantId, spaceId, userId: principal.sub, title })
        return `created page ${page.id}`
      } catch (e) {
        const sc = (e as { statusCode?: number }).statusCode
        if (sc === 403 || sc === 404) throw toolError('cannot create a page in that space')
        throw e
      }
    },
  },
  {
    name: 'publish_page',
    description: "Publish a page's current draft (requires edit access). Records a revision; a no-op if nothing changed.",
    scope: 'write',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] },
    async run(req, app, principal, args) {
      const pageId = typeof args.pageId === 'string' ? args.pageId : ''
      if (!pageId) throw toolError('pageId is required')
      // Thin broker: publishPage gates FGA `edit` on the page FIRST (403 for a non-editor → uniform message,
      // existence-hiding). Publishes the current single-Y.Text draft (never a raw content overwrite).
      try {
        const r = await publishPage(req.db, app.fga, app.searchDriver, app.storageDriver, { pageId, subject: `user:${principal.sub}`, createdBy: `user:${principal.sub}` })
        return r.noop ? 'no changes to publish' : `published page ${pageId}${r.revisionId ? ` (revision ${r.revisionId})` : ''}`
      } catch (e) {
        const sc = (e as { statusCode?: number }).statusCode
        if (sc === 403 || sc === 404) throw toolError('cannot publish that page')
        throw e
      }
    },
  },
  {
    name: 'edit_body',
    description:
      "Edit a page's DRAFT body (requires edit access). op 'append' adds a block at the end; op 'replace_section' " +
      'replaces the section under a heading (by heading text) with new markdown. The content is CommonMark/GFM ' +
      'with Wikistead macros — call get_syntax_reference for the notation. Edits the live draft (visible to ' +
      'editors immediately); it does NOT publish — call publish_page to record a public revision.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string' },
        op: { type: 'string', enum: ['append', 'replace_section'] },
        content: { type: 'string' },
        heading: { type: 'string', description: 'target heading text (required for replace_section)' },
      },
      required: ['pageId', 'op', 'content'],
    },
    async run(req, app, principal, args) {
      const pageId = typeof args.pageId === 'string' ? args.pageId : ''
      const op = args.op === 'append' || args.op === 'replace_section' ? args.op : null
      const content = typeof args.content === 'string' ? args.content : ''
      const heading = typeof args.heading === 'string' ? args.heading : undefined
      if (!pageId) throw toolError('pageId is required')
      if (!op) throw toolError("op must be 'append' or 'replace_section'")
      if (!content.trim()) throw toolError('content is required')
      if (op === 'replace_section' && !heading?.trim()) throw toolError('heading is required for replace_section')
      if (content.length > MAX_EDIT_BODY_CHARS) throw toolError('content is too large')
      // Layer 3 of the write gate: OpenFGA `edit` on the page, on user:<sub>, BEFORE any collab dispatch. A
      // non-editor (or a missing page) is a uniform "cannot edit that page" (existence-hiding). The collab pod
      // RE-CHECKS this (two-sided authz, ADR-144 §3) — the HTTP gate is not the only guard on the content write.
      const allowed = await check(app.fga, `user:${principal.sub}`, 'edit', { type: 'page', id: pageId })
      if (!allowed) throw toolError('cannot edit that page')
      // The edit is applied to the canonical single Y.Text by a collab pod (never here). NEVER a published_md
      // overwrite; publishing is the separate publish_page tool (ADR-019 / ADR-144 §2).
      let result
      try {
        result = await mcpEditDraft(app.valkey, docName(principal.tenantId, pageId), {
          op, content, heading, user: `user:${principal.sub}`, tenant: principal.tenantId, sizeCap: MAX_EDIT_BODY_CHARS,
        })
      } catch (e) {
        if (e instanceof CollabUnavailableError) throw toolError('the page is not open for editing right now; please retry')
        throw e
      }
      if (!result.ok) throw toolError(result.error === 'forbidden' ? 'cannot edit that page' : result.error ?? 'edit failed')
      return op === 'append'
        ? `appended to the draft of page ${pageId}`
        : `replaced section "${heading}" in the draft of page ${pageId}`
    },
  },
  {
    name: 'create_comment',
    description: 'Add a page-level comment to a page (requires comment access). The body is CommonMark/GFM and supports Wikistead macros — call get_syntax_reference for the notation. Returns the thread id.',
    scope: 'write',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, body: { type: 'string' } }, required: ['pageId', 'body'] },
    async run(req, app, principal, args) {
      const pageId = typeof args.pageId === 'string' ? args.pageId : ''
      const body = typeof args.body === 'string' ? args.body : ''
      if (!pageId) throw toolError('pageId is required')
      if (!body.trim()) throw toolError('body is required')
      // Thin broker: createPageComment gates `view` (404, existence-hiding) then `comment` (403), inside a tx.
      try {
        const { threadId } = await createPageComment(req.db, app.fga, { tenantId: principal.tenantId, pageId, subject: `user:${principal.sub}`, authorId: principal.sub, body })
        return `added comment (thread ${threadId})`
      } catch (e) {
        const sc = (e as { statusCode?: number }).statusCode
        if (sc === 403 || sc === 404) throw toolError('cannot comment on that page')
        if (sc === 400) throw toolError('body is required')
        throw e
      }
    },
  },
]

// A tool-level error carried back as an MCP tool result with isError:true (not a JSON-RPC protocol error).
class ToolError extends Error {}
const toolError = (m: string) => new ToolError(m)

interface JsonRpcRequest { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

function rpcResult(id: JsonRpcRequest['id'], result: unknown) { return { jsonrpc: '2.0', id: id ?? null, result } }
function rpcError(id: JsonRpcRequest['id'], code: number, message: string) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } } }

// Point an unauthenticated caller at the protected-resource metadata so the MCP client can start OAuth (RFC 9728).
function unauthorized(req: FastifyRequest, reply: FastifyReply) {
  const base = `${req.protocol}://${req.headers.host}`
  reply.header('www-authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
  return reply.code(401).send({ error: 'unauthorized' })
}

export async function mcpPlugin(app: FastifyInstance) {
  // Public route: authentication is the Bearer access token (not a session cookie). Tenant is Host-resolved.
  app.post<{ Body: JsonRpcRequest }>('/mcp', { config: { public: true } }, async (req, reply) => {
    let principal: McpPrincipal
    try {
      principal = await authenticateMcpRequest(req, req.tenant.id)
    } catch {
      return unauthorized(req, reply)
    }

    const body = (req.body ?? {}) as JsonRpcRequest
    const { id, method } = body
    // A JSON-RPC notification (no id) — e.g. notifications/initialized — gets no response body.
    if (id == null && typeof method === 'string' && method.startsWith('notifications/')) return reply.code(202).send()

    switch (method) {
      case 'initialize':
        return rpcResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO })
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
      case 'tools/call': {
        const name = typeof body.params?.name === 'string' ? body.params.name : ''
        const tool = TOOLS.find((t) => t.name === name)
        if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`)
        // Enforce the token's scopes as a ceiling (read-only token cannot call a write tool).
        if (!principal.scopes.includes(tool.scope)) return rpcResult(id, { content: [{ type: 'text', text: `error: missing '${tool.scope}' scope` }], isError: true })
        // WRITE tools are additionally entitlement-gated (ADR-131 write = Cloud/EE via the `mcpWrite`
        // entitlement; read is all-plans). Resolved in the one entitlement seam, never `if (plan)`. OpenFGA
        // still gates the specific resource inside the broker (two layers).
        if (tool.scope === 'write' && !resolveEntitlements(req.tenant.plan).mcpWrite) {
          return rpcResult(id, { content: [{ type: 'text', text: 'error: MCP write access is not available on this plan' }], isError: true })
        }
        try {
          const text = await tool.run(req, app, principal, (body.params?.arguments ?? {}) as Record<string, unknown>)
          return rpcResult(id, { content: [{ type: 'text', text }] })
        } catch (e) {
          if (e instanceof ToolError) return rpcResult(id, { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true })
          // Any other failure (DB outage etc.) → a GENERIC JSON-RPC internal error; never the raw exception
          // message (which could carry internals). Uniform regardless of the page, so no existence oracle.
          req.log.error({ err: e }, 'mcp tool failed')
          return rpcError(id, -32603, 'internal error')
        }
      }
      default:
        return rpcError(id, -32601, `method not found: ${method ?? ''}`)
    }
  })
}

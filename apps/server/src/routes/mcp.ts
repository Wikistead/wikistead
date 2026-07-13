import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getPublished } from './pages.js'
import { authenticateMcpRequest, type McpPrincipal } from '../auth/mcp-request-auth.js'

// #311 / ADR-131 slice 5: the MCP endpoint — a minimal Streamable-HTTP (JSON-RPC 2.0 over POST) transport with a
// READ-first tool surface (v1). Every request is Bearer-authenticated (slice 4 token) + tenant-bound
// (authenticateMcpRequest); each tool is a THIN BROKER over an existing service fn called as `user:<sub>`, so
// OpenFGA is re-checked per operation and a view-denied resource is the SAME uniform not-found as a missing one
// (existence-hiding). The tool holds no db/fga handle beyond what the host passes — the ADR-075 broker rule.
// This slice ships ONE read tool (get_page); more (search / list spaces / tree / backlinks) are additive.

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'wikistead', version: '0.1.0' }

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

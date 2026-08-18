// THE origin route table (#724 / ADR-231).
//
// One origin serves the SPA, the API, the collab socket and every machine-facing endpoint
// (ADR-016), and until this file existed the mapping was written down three times — the dev proxy,
// the Caddy config and the Kubernetes ingress — with nothing comparing them. They drifted, and the
// drift was invisible because every browser test runs behind the dev proxy:
//
//   - the client prefixes /api, the dev proxy stripped it, the edges did not, and the server serves
//     bare paths → a deployed stack answered 404 to EVERY api call;
//   - /auth and /signup had no edge route at all → sign-in landed on the SPA shell and could not
//     start;
//   - /robots.txt was answered by index.html → the public-visibility switch (#253, ADR-154) was
//     silently void at the edge;
//   - the MCP OAuth metadata, the Stripe webhook and /scim/v2 had no route either;
//   - /collab was routed by the ingress and NOT by Caddy, whose `handle /collab/*` never matches
//     the bare /collab the client opens. Two edges disagreeing about one origin.
//
// So the table lives here, the dev proxy is BUILT from it, the edge configs are CHECKED against it
// (owner rulingcheck, not generate, in v1), and the release-side traversal generates one
// probe per row. Plain .mjs so the vite config, the checker and the probe generator can all import
// it without a build step.

/**
 * @typedef {Object} OriginRoute
 * @property {string} path        the public path prefix, exactly as the browser or an outside
 *                                system uses it
 * @property {'server'|'collab'|'web'} upstream
 * @property {boolean} strip      does the edge remove `path` before forwarding? Only /api does —
 *                                every other row's path IS the server's path
 * @property {boolean} exact      true when the client also opens the bare path itself (no trailing
 *                                segment). `/collab` is the case that made this column necessary
 * @property {boolean} ws         WebSocket upgrade
 * @property {string} why         why this row exists — read it before deleting a row
 */

/** @type {OriginRoute[]} */
export const ORIGIN_ROUTES = [
  {
    path: '/api',
    upstream: 'server',
    strip: true,
    exact: false,
    ws: false,
    why: 'The SPA and every API client call ${origin}/api/... (apiClient.ts and four siblings). The prefix is an EDGE concern: the server registers bare paths, its 386 route assertions use them, and mail already went out containing ${baseUrl}/api/... links.',
  },
  {
    path: '/collab',
    upstream: 'collab',
    // NOT stripped, so /api stays the only special case in this table. Hocuspocus reads the
    // document name from the protocol and ignores the path entirely, so either value works at
    // runtime — but the table has to state ONE, and the edges disagreed about this row before
    // (the ingress preserved it, Caddy's matcher missed it altogether).
    strip: false,
    exact: true,
    ws: true,
    why: 'The Yjs provider opens exactly ${origin}/collab — no trailing segment, which is why `exact` exists. Hocuspocus reads the document name from the protocol, not the path.',
  },
  {
    path: '/auth',
    upstream: 'server',
    strip: false,
    exact: false,
    ws: false,
    why: 'Top-level navigation (sign-in start, IdP callback, the SAML ACS the admin console already prints). The path must survive end to end or the redirect_uri the browser saw stops matching what the server reconstructs.',
  },
  {
    path: '/signup',
    upstream: 'server',
    strip: false,
    exact: false,
    ws: false,
    why: 'Same shape as /auth: the browser navigates here, the server answers.',
  },
  {
    path: '/pub',
    upstream: 'server',
    strip: false,
    exact: false,
    ws: false,
    why: 'The crawler-facing HTML shell with per-page head tags (#409 / ADR-154). The static web container would serve a shell with no metadata.',
  },
  {
    path: '/robots.txt',
    upstream: 'server',
    strip: false,
    exact: true,
    ws: false,
    why: 'The server decides what may be indexed from the tenant\'s public switch (#253 / ADR-154 §4). Served by the web container it becomes index.html with a 200, and the switch means nothing.',
  },
  {
    path: '/sitemap.xml',
    upstream: 'server',
    strip: false,
    exact: true,
    ws: false,
    why: 'Generated from the pages a tenant actually published — same switch as robots.txt.',
  },
  {
    path: '/.well-known/oauth-authorization-server',
    upstream: 'server',
    strip: false,
    exact: true,
    ws: false,
    why: 'RFC 8414 discovery for the MCP connector. The client fetches it before anything else, at a path the spec fixes.',
  },
  {
    path: '/.well-known/oauth-protected-resource',
    upstream: 'server',
    strip: false,
    exact: true,
    ws: false,
    why: 'RFC 9728 discovery, same flow.',
  },
  {
    path: '/mcp',
    upstream: 'server',
    strip: false,
    exact: true,
    ws: false,
    why: 'The MCP endpoint itself (ADR-131 documents https://<tenant>/mcp). AI assistants are configured with this URL by hand, so it cannot move behind /api.',
  },
  {
    path: '/mcp/oauth',
    upstream: 'server',
    strip: false,
    exact: false,
    ws: false,
    why: 'authorize / token / register / consent. The metadata above advertises these absolute URLs, so they must resolve exactly as advertised.',
  },
  {
    path: '/webhooks/stripe',
    upstream: 'server',
    strip: false,
    exact: true,
    ws: false,
    why: 'Stripe calls this URL from outside with a signed body. Note the sibling /webhooks/* under /api is the TENANT-facing CRUD — this row is only the inbound callback, which is why the path is exact.',
  },
  {
    path: '/scim/v2',
    upstream: 'server',
    strip: false,
    exact: false,
    ws: false,
    why: 'The customer pastes this into their IdP verbatim (ADR-070, owner ruling— it stays top-level rather than moving under /api).',
  },
  {
    path: '/',
    upstream: 'web',
    strip: false,
    exact: false,
    ws: false,
    why: 'The SPA, and the fallback: anything not claimed above is a client route and must answer index.html.',
  },
]

/** Everything except the catch-all, in declaration order. */
export const PROXIED_ROUTES = ORIGIN_ROUTES.filter((r) => r.upstream !== 'web')

/** Health endpoints are hit pod-directly by the orchestrator and are deliberately NOT edge rows. */
export const NOT_EDGE_ROUTES = ['/healthz', '/readyz']

import { deflateSync } from 'node:zlib'

// PlantUML/Kroki external render proxy (#140 / ADR-074). The host-mediated server fetch behind the
// `plantuml` macro: the macro NEVER fetches (it only stores source); the HOST POSTs the source to
// an OPERATOR-CONFIGURED endpoint and returns a raster image. License boundary (ADR-011/074): the
// GPL engine runs OUT of process at the operator's Kroki/PlantUML-server — Wikistead ships only this
// HTTP client (no GPL/JRE/Graphviz bundled). Unset endpoint / failure / non-image ⇒ null (the caller
// degrades to the source fence — Open formats; never a broken embed).
//
// SECURITY: the endpoint is the OPERATOR-fixed env value — a user/tenant cannot redirect the fetch
// (no user-controlled URL; the diagram source goes in the path, not as a URL). redirect:'error'
// stops a 30x bounce to an internal host; no credentials are forwarded; PNG-only output means no
// SVG/XSS surface (ADR-074 prefers raster). page-view authz is enforced by the route before calling.

export const MAX_RENDER_BYTES = 2 * 1024 * 1024
type Fetcher = (url: string) => Promise<Response>

// #342: the built-in PlantUML dark theme injected for dark-mode renders (user ruling use a
// built-in `!theme`, not app-matched skinparam). `carbon-gray` is a real built-in (reviewer-vetted,
//) — the exact choice is a visual call, swap this one constant to re-tune. Light mode injects
// nothing (the default look).
export const PLANTUML_DARK_THEME = 'carbon-gray'

// #342: prepend the dark `!theme` to a PlantUML source, UNLESS the author already set their own theme.
// Respect an explicit `!theme` or `skinparam` on any line START (PlantUML comments begin with `'` or sit
// inside `/' … '/`, so a leading-quote line is a comment and never a real directive — note 2). The
// directive must sit INSIDE the diagram, so it goes right after the first `@start…`; a snippet with no
// `@start…` gets it prepended (still valid). Idempotent-safe: returns the source untouched when explicit.
export function injectPlantumlTheme(source: string, themeName = PLANTUML_DARK_THEME): string {
  const lines = source.split('\n')
  const hasExplicit = lines.some((line) => {
    const t = line.trimStart()
    return /^!theme\b/i.test(t) || /^skinparam\b/i.test(t)
  })
  if (hasExplicit) return source
  const directive = `!theme ${themeName}`
  const startIdx = lines.findIndex((l) => /^\s*@start\w*/i.test(l))
  if (startIdx >= 0) {
    lines.splice(startIdx + 1, 0, directive)
    return lines.join('\n')
  }
  return `${directive}\n${source}`
}

async function defaultFetch(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { redirect: 'error', signal: ctrl.signal, headers: {} }) // no creds; no redirect bounce
  } finally {
    clearTimeout(timer)
  }
}

// Render `source` to PNG bytes via the operator endpoint, or null to degrade-to-source. `endpoint`
// defaults to PLANTUML_RENDER_URL (a Kroki-compatible base, e.g. https://kroki.example/); the source
// is zlib-deflated + base64url into the Kroki GET path so no separate POST body is needed.
export async function renderPlantuml(
  source: string,
  opts: { fetcher?: Fetcher; endpoint?: string; timeoutMs?: number; dark?: boolean } = {},
): Promise<Buffer | null> {
  const base = (opts.endpoint ?? process.env.PLANTUML_RENDER_URL ?? '').replace(/\/+$/, '')
  if (!base) return null // not configured → operator opt-in not taken → degrade
  const themed = opts.dark ? injectPlantumlTheme(source) : source // #342: dark → inject a built-in !theme
  const encoded = deflateSync(Buffer.from(themed, 'utf8')).toString('base64url')
  const url = `${base}/plantuml/png/${encoded}`
  let res: Response
  try {
    res = await (opts.fetcher ?? ((u) => defaultFetch(u, opts.timeoutMs ?? 5000)))(url)
  } catch {
    return null // endpoint down / timeout / redirect-blocked → degrade
  }
  if (!res.ok) return null
  if (!(res.headers.get('content-type') ?? '').startsWith('image/')) return null // raster only (no XSS)
  return readBoundedBytes(res, MAX_RENDER_BYTES)
}

// Read up to `maxBytes` of the image body, degrading to null if it exceeds the cap. content-length
// is a cheap first reject but is NOT trusted: a chunked / absent-header / lying endpoint could still
// stream an unbounded body, and `res.arrayBuffer()` would buffer the WHOLE thing into memory first
// (OOM DoS). Stream-read and abort the moment we pass the cap — at most maxBytes is ever buffered.
async function readBoundedBytes(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) return null
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.byteLength > 0 && buf.byteLength <= maxBytes ? buf : null
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      return null // over cap → degrade to source (never a broken/oversized embed)
    }
    chunks.push(value)
  }
  return total > 0 ? Buffer.concat(chunks) : null // empty body → degrade
}

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

// #342 a readable dark for PlantUML. The built-in `!theme`s (carbon-gray etc.) only recolour ELEMENTS —
// the canvas stays WHITE, so black text on a white box reads terribly on a dark app. Real "readable dark" needs
// `skinparam` (the option first deferred): a dark canvas + light text/lines across the common diagram
// element types. Colours track the app's dark surface tokens (panel/border/fg). Swap these to re-tune.
const DARK = { bg: '#1E1E22', panel: '#2C2C31', border: '#55555C', fg: '#E6E6E6', line: '#C8C8C8' } as const
export const PLANTUML_DARK_SKINPARAM: readonly string[] = [
  `skinparam backgroundColor ${DARK.bg}`,
  `skinparam defaultFontColor ${DARK.fg}`,
  `skinparam ArrowColor ${DARK.line}`,
  `skinparam ArrowFontColor ${DARK.fg}`,
  `skinparam TitleFontColor ${DARK.fg}`,
  `skinparam NoteBackgroundColor ${DARK.panel}`,
  `skinparam NoteBorderColor ${DARK.border}`,
  `skinparam NoteFontColor ${DARK.fg}`,
  `skinparam ActorBorderColor ${DARK.line}`,
  `skinparam ActorFontColor ${DARK.fg}`,
  `skinparam ParticipantBackgroundColor ${DARK.panel}`,
  `skinparam ParticipantBorderColor ${DARK.border}`,
  `skinparam ParticipantFontColor ${DARK.fg}`,
  `skinparam SequenceLifeLineBorderColor ${DARK.border}`,
  `skinparam SequenceBoxBackgroundColor ${DARK.bg}`,
  // Boxed node types (class / component / rectangle / state / activity / usecase / object) share the palette.
  ...['Class', 'Component', 'Rectangle', 'State', 'Activity', 'Usecase', 'Object', 'Node', 'Package'].flatMap((k) => [
    `skinparam ${k}BackgroundColor ${DARK.panel}`,
    `skinparam ${k}BorderColor ${DARK.border}`,
    `skinparam ${k}FontColor ${DARK.fg}`,
  ]),
  `skinparam ClassAttributeFontColor ${DARK.fg}`,
]

// #342 inject the dark `skinparam` block into a PlantUML source, UNLESS the author already set their own
// theme. Respect an explicit `!theme` or `skinparam` on any line START (PlantUML comments begin with `'` or sit
// inside `/' … '/`, so a leading-quote line is a comment and never a real directive — note 2). skinparam
// must sit INSIDE the diagram, so it goes right after the first `@start…`; a snippet with no `@start…` gets it
// prepended (still valid). Idempotent-safe: returns the source untouched when the author styled it explicitly.
export function injectPlantumlTheme(source: string, skinparam: readonly string[] = PLANTUML_DARK_SKINPARAM): string {
  const lines = source.split('\n')
  const hasExplicit = lines.some((line) => {
    const t = line.trimStart()
    return /^!theme\b/i.test(t) || /^skinparam\b/i.test(t)
  })
  if (hasExplicit) return source
  const startIdx = lines.findIndex((l) => /^\s*@start\w*/i.test(l))
  if (startIdx >= 0) {
    lines.splice(startIdx + 1, 0, ...skinparam)
    return lines.join('\n')
  }
  return `${[...skinparam, source].join('\n')}`
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

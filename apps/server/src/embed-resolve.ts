import type { OpenFgaClient } from '@openfga/sdk'
import type { CheckContext } from '@wikistead/authz'
import { assertPageViewable } from './page-view-gate.js'
import { safeFetch } from './safe-fetch.js'

// Server-side external-embed resolution (#108 / ADR-071). The evaluation ORDER is the security
// contract (ADR-071): (1) PAGE-VIEW GATE first — only a principal who can `view` THIS page may
// trigger a fetch (an authoring-time URL can't be fetched by a later viewer who lacks view —
// monotonic deny); (2) tenant PROVIDER ALLOWLIST — default empty ⇒ every external host denied
// (operator opt-in); (3) SSRF-GUARDED fetch (safe-fetch: https-only, private/loopback/metadata IP
// rejection, no redirect, no credential forwarding) — so no principal id / internal URL / auth
// leaves to the provider. Returns the bounded body + content-type; HTML sanitization (ADR-059)
// happens at render, not here.

export class EmbedDeniedError extends Error {
  statusCode = 403
  constructor(message = 'forbidden') {
    super(message)
  }
}

export const MAX_EMBED_BYTES = 256 * 1024
// Embeds resolve to oEmbed/unfurl metadata or markup — text-ish only; binary/unknown is rejected.
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/json', 'application/xml', 'text/xml', 'text/plain']

type Fetcher = (url: string) => Promise<Response>

export async function resolveEmbed(
  deps: { fga: OpenFgaClient; fetcher?: Fetcher },
  args: { principal: string; pageId: string; url: string; allowlist: readonly string[]; context?: CheckContext },
): Promise<{ contentType: string; body: string }> {
  // (1) Page-view gate FIRST — throws 403 if the principal cannot view the page (no fetch happens).
  await assertPageViewable(deps.fga, args.principal, args.pageId, args.context)

  // (2) Provider allowlist (exact host). Default empty ⇒ deny all external embeds (opt-in).
  let host: string
  try {
    host = new URL(args.url).hostname
  } catch {
    throw new EmbedDeniedError('invalid url')
  }
  if (!args.allowlist.includes(host)) throw new EmbedDeniedError('provider not allowlisted')

  // (3) SSRF-guarded fetch (safe-fetch). content-length + content-type bounded.
  const res = await (deps.fetcher ?? safeFetch)(args.url)
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) throw new EmbedDeniedError('unsupported content-type')
  // Fast reject on an honest content-length header...
  const declaredLen = Number(res.headers.get('content-length') ?? 0)
  if (declaredLen > MAX_EMBED_BYTES) throw new EmbedDeniedError('embed too large')
  // ...but never TRUST it: a chunked / absent-header / lying response could still stream an
  // unbounded body. `res.text()` would buffer the WHOLE thing into memory first (OOM DoS), so read
  // the stream and abort the moment we exceed the cap — at most MAX_EMBED_BYTES is ever buffered.
  const body = await readBounded(res, MAX_EMBED_BYTES)
  return { contentType, body }
}

// Stream-read up to `maxBytes`; cancel + reject as soon as the body exceeds it (don't slice-and-
// return a truncated half-document — be consistent with the content-length rejection above). Falls
// back to a bounded text read only when the platform exposes no body stream.
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) {
    const text = await res.text()
    if (text.length > maxBytes) throw new EmbedDeniedError('embed too large')
    return text
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new EmbedDeniedError('embed too large')
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    buf.set(c, offset)
    offset += c.length
  }
  return new TextDecoder().decode(buf)
}

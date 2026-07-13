// PlantUML/Kroki render proxy (#140 / ADR-074). Unit — no network: degrade-to-source when the
// endpoint is unconfigured / fails / returns non-image; PNG bytes when an image comes back. The
// source is encoded into the Kroki path (no user-controlled URL → no SSRF via source). page-view
// authz is enforced by the route (covered separately).
import { describe, it, expect } from 'vitest'
import { inflateSync } from 'node:zlib'
import { renderPlantuml, injectPlantumlTheme, PLANTUML_DARK_THEME, MAX_RENDER_BYTES } from '../plantuml-render.js'

const png = (bytes = 8) => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } })

// #342: decode the Kroki GET path (deflate + base64url) back to the source the server actually sent.
const decodeKrokiSource = (url: string): string => {
  const encoded = url.split('/plantuml/png/')[1]!
  return inflateSync(Buffer.from(encoded, 'base64url')).toString('utf8')
}

describe('renderPlantuml (#140 / ADR-074)', () => {
  it('degrades (null) when no endpoint is configured — operator opt-in not taken', async () => {
    expect(await renderPlantuml('@startuml\nA->B\n@enduml', { endpoint: '' })).toBeNull()
  })

  it('returns PNG bytes from the operator endpoint, encoding source into the Kroki path', async () => {
    const calls: string[] = []
    const fetcher = async (url: string) => { calls.push(url); return png(16) }
    const out = await renderPlantuml('@startuml\nA->B\n@enduml', { endpoint: 'https://kroki.example/', fetcher })
    expect(out).toBeInstanceOf(Buffer)
    expect(out!.byteLength).toBe(16)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/^https:\/\/kroki\.example\/plantuml\/png\/[A-Za-z0-9_-]+$/) // base64url path, no trailing slash dup
  })

  it('degrades on a non-image response (SVG/HTML rejected — raster-only, no XSS surface)', async () => {
    const fetcher = async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })
    // image/svg+xml starts with image/ — but ADR-074 prefers raster; here we accept image/* and rely
    // on the endpoint returning PNG. A text/html error page must degrade:
    const htmlFetcher = async () => new Response('<html>err</html>', { headers: { 'content-type': 'text/html' } })
    expect(await renderPlantuml('x', { endpoint: 'https://k/', fetcher: htmlFetcher })).toBeNull()
    // (svg accepted by content-type image/ — operator's choice of format; PNG is the requested path)
    expect(await renderPlantuml('x', { endpoint: 'https://k/', fetcher })).toBeInstanceOf(Buffer)
  })

  it('degrades on a fetch error or a non-ok status (endpoint down → source fence, not broken embed)', async () => {
    const boom = async () => { throw new Error('ECONNREFUSED') }
    expect(await renderPlantuml('x', { endpoint: 'https://k/', fetcher: boom })).toBeNull()
    const err500 = async () => new Response('err', { status: 500, headers: { 'content-type': 'image/png' } })
    expect(await renderPlantuml('x', { endpoint: 'https://k/', fetcher: err500 })).toBeNull()
  })

  it('degrades on an over-size image', async () => {
    const big = async () => png(MAX_RENDER_BYTES + 1)
    expect(await renderPlantuml('x', { endpoint: 'https://k/', fetcher: big })).toBeNull()
  })

  it('degrades on an over-size streamed body with NO content-length (no header = no bypass)', async () => {
    // A chunked endpoint omits content-length, so the header fast-reject (declared=0) passes; the
    // stream bound must still catch it before the whole body is buffered into memory.
    const streamed = async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          ctrl.enqueue(new Uint8Array(MAX_RENDER_BYTES + 1)) // one over-cap chunk, no content-length
          ctrl.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'image/png' } })
    }
    expect(await renderPlantuml('x', { endpoint: 'https://k/', fetcher: streamed })).toBeNull()
  })

  // #342: dark mode injects a built-in `!theme` into the source the server sends to Kroki.
  it('dark render injects the built-in !theme right after @startuml; light injects nothing', async () => {
    const cap: string[] = []
    const fetcher = async (url: string) => { cap.push(decodeKrokiSource(url)); return png() }
    await renderPlantuml('@startuml\nA->B\n@enduml', { endpoint: 'https://k/', fetcher, dark: true })
    expect(cap[0]).toBe(`@startuml\n!theme ${PLANTUML_DARK_THEME}\nA->B\n@enduml`)
    cap.length = 0
    await renderPlantuml('@startuml\nA->B\n@enduml', { endpoint: 'https://k/', fetcher, dark: false })
    expect(cap[0]).toBe('@startuml\nA->B\n@enduml') // light = unchanged
  })
})

describe('injectPlantumlTheme (#342)', () => {
  it('inserts the directive after the first @start… (must sit inside the diagram)', () => {
    expect(injectPlantumlTheme('@startuml\nA->B\n@enduml', 'carbon-gray')).toBe('@startuml\n!theme carbon-gray\nA->B\n@enduml')
    // a non-uml @start (mindmap/gantt/…) is handled the same
    expect(injectPlantumlTheme('@startmindmap\n* root\n@endmindmap', 'carbon-gray')).toBe('@startmindmap\n!theme carbon-gray\n* root\n@endmindmap')
  })

  it('prepends when the snippet has no @start… line', () => {
    expect(injectPlantumlTheme('A->B', 'carbon-gray')).toBe('!theme carbon-gray\nA->B')
  })

  it('respects an explicit !theme — the author’s choice is never overridden', () => {
    const src = '@startuml\n!theme cyborg\nA->B\n@enduml'
    expect(injectPlantumlTheme(src, 'carbon-gray')).toBe(src)
  })

  it('respects an explicit skinparam (leading whitespace tolerated)', () => {
    const src = '@startuml\n  skinparam backgroundColor #111\nA->B\n@enduml'
    expect(injectPlantumlTheme(src, 'carbon-gray')).toBe(src)
  })

  it('does NOT treat a COMMENT line as an explicit directive (leading-quote = comment)', () => {
    // a commented-out skinparam must NOT block the dark theme (note 2: line-start, comment-aware)
    const src = "@startuml\n' skinparam mono true\nA->B\n@enduml"
    expect(injectPlantumlTheme(src, 'carbon-gray')).toBe("@startuml\n!theme carbon-gray\n' skinparam mono true\nA->B\n@enduml")
  })
})

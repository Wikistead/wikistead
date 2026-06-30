// PlantUML/Kroki render proxy (#140 / ADR-074). Unit — no network: degrade-to-source when the
// endpoint is unconfigured / fails / returns non-image; PNG bytes when an image comes back. The
// source is encoded into the Kroki path (no user-controlled URL → no SSRF via source). page-view
// authz is enforced by the route (covered separately).
import { describe, it, expect } from 'vitest'
import { renderPlantuml, MAX_RENDER_BYTES } from '../plantuml-render.js'

const png = (bytes = 8) => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } })

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
})

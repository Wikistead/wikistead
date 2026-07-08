// External-embed resolution security gates (#108 / ADR-071). Verifies the evaluation ORDER and
// that a fetch happens ONLY when the page-view gate AND the provider allowlist both pass — proven
// with a recording stub fetcher (no network) + a fake fga: a non-viewer or a non-allowlisted host
// never reaches the fetch; an allowed embed returns the bounded body; bad content-type/size deny.
import { describe, it, expect } from 'vitest'
import { resolveEmbed, EmbedDeniedError, MAX_EMBED_BYTES } from '../embed-resolve.js'

// fga that authorizes `view` only on page:ok.
const fga = (viewable: boolean) => ({ check: async () => ({ allowed: viewable }) }) as never

function stubFetcher(body: string, headers: Record<string, string>) {
  const calls: string[] = []
  const fetcher = async (url: string) => {
    calls.push(url)
    return new Response(body, { headers })
  }
  return { fetcher, calls }
}

const ALLOW = ['embed.example.com']
const base = { principal: 'user:u', pageId: 'ok', url: 'https://embed.example.com/x', allowlist: ALLOW }

describe('resolveEmbed (#108 / ADR-071 external embed gates)', () => {
  it('a non-viewer of the page is denied and NO fetch happens', async () => {
    const { fetcher, calls } = stubFetcher('hi', { 'content-type': 'text/html' })
    // #280: the page-view gate throws 404 not-found (existence-hiding), not 403 — a non-viewer can't
    // tell the page exists. (An allowlist/SSRF rejection below keeps 403: the page IS viewable there.)
    await expect(resolveEmbed({ fga: fga(false), fetcher }, base)).rejects.toMatchObject({ statusCode: 404 })
    expect(calls).toHaveLength(0) // page-view gate is first — no egress for a non-viewer
  })

  it('a non-allowlisted host is denied and NO fetch happens (default-empty = deny all)', async () => {
    const { fetcher, calls } = stubFetcher('hi', { 'content-type': 'text/html' })
    await expect(resolveEmbed({ fga: fga(true), fetcher }, { ...base, allowlist: [] })).rejects.toBeInstanceOf(EmbedDeniedError)
    expect(calls).toHaveLength(0)
    await expect(resolveEmbed({ fga: fga(true), fetcher }, { ...base, url: 'https://evil.example.com/x' })).rejects.toBeInstanceOf(EmbedDeniedError)
    expect(calls).toHaveLength(0)
  })

  it('a viewer + allowlisted host fetches and returns the bounded body', async () => {
    const { fetcher, calls } = stubFetcher('<oembed>ok</oembed>', { 'content-type': 'text/html; charset=utf-8' })
    const r = await resolveEmbed({ fga: fga(true), fetcher }, base)
    expect(calls).toEqual([base.url]) // egress happened only after both gates passed
    expect(r).toEqual({ contentType: 'text/html', body: '<oembed>ok</oembed>' })
  })

  it('rejects an unsupported content-type and an over-size embed', async () => {
    const bad = stubFetcher('binary', { 'content-type': 'application/octet-stream' })
    await expect(resolveEmbed({ fga: fga(true), fetcher: bad.fetcher }, base)).rejects.toBeInstanceOf(EmbedDeniedError)
    const big = stubFetcher('x', { 'content-type': 'text/html', 'content-length': String(MAX_EMBED_BYTES + 1) })
    await expect(resolveEmbed({ fga: fga(true), fetcher: big.fetcher }, base)).rejects.toBeInstanceOf(EmbedDeniedError)
  })

  it('rejects an over-size body even when content-length is ABSENT (no header = no bypass)', async () => {
    // A chunked / lying provider omits content-length so the header check (declaredLen=0) passes;
    // the stream bound must still catch it before the whole body is buffered into memory.
    const oversized = 'a'.repeat(MAX_EMBED_BYTES + 1)
    const { fetcher } = stubFetcher(oversized, { 'content-type': 'text/html' }) // note: no content-length
    await expect(resolveEmbed({ fga: fga(true), fetcher }, base)).rejects.toBeInstanceOf(EmbedDeniedError)
  })

  it('accepts a body exactly at the cap (boundary inclusive, off-by-one guard)', async () => {
    const atCap = 'a'.repeat(MAX_EMBED_BYTES)
    const { fetcher } = stubFetcher(atCap, { 'content-type': 'text/html' })
    const r = await resolveEmbed({ fga: fga(true), fetcher }, base)
    expect(r.body.length).toBe(MAX_EMBED_BYTES) // exactly-at-cap allowed; only > cap rejects
  })
})

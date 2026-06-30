// Internal transclude resolution (#108 / ADR-071) — the authz + cycle/depth guard. Pure (fake fga
// + db): a non-viewer of the referenced page gets the existence-hiding placeholder with NO db read;
// unpublished/absent yields the SAME placeholder (no oracle); a viewer gets the content; cycles and
// over-depth chains stop before recursing.
import { describe, it, expect } from 'vitest'
import { resolveTranscludeRef, transcludeStop, MAX_TRANSCLUDE_DEPTH } from '../transclude-resolve.js'

const fga = (viewable: boolean) => ({ check: async () => ({ allowed: viewable }) }) as never
// fake db: returns published_md for known pages, else empty.
function db(pages: Record<string, string | null>) {
  return { sql: async (_s: TemplateStringsArray, id: string) => (id in pages ? [{ published_md: pages[id] }] : []) } as never
}

describe('transcludeStop (#108 / ADR-071)', () => {
  it('flags a cycle (chain revisits the page) and over-depth', () => {
    expect(transcludeStop(['a', 'b'], 'a')).toBe('cycle')
    expect(transcludeStop(Array.from({ length: MAX_TRANSCLUDE_DEPTH }, (_, i) => `p${i}`), 'new')).toBe('depth')
    expect(transcludeStop(['a'], 'b')).toBeNull()
  })
})

describe('resolveTranscludeRef (#108 / ADR-071)', () => {
  it('a non-viewer gets the denied placeholder and NO content is read', async () => {
    let read = false
    const tracking = { sql: async () => { read = true; return [{ published_md: 'SECRET' }] } } as never
    const r = await resolveTranscludeRef({ db: tracking, fga: fga(false) }, { principal: 'user:u', refPageId: 'b' })
    expect(r).toEqual({ ok: false, reason: 'denied' })
    expect(read).toBe(false) // authz first — the referenced content is never fetched for a non-viewer
  })

  it('a viewer gets the published content', async () => {
    const r = await resolveTranscludeRef({ db: db({ b: '# B body' }), fga: fga(true) }, { principal: 'user:u', refPageId: 'b' })
    expect(r).toEqual({ ok: true, content: '# B body' })
  })

  it('unpublished/absent yields the SAME placeholder as unviewable (no existence oracle)', async () => {
    expect(await resolveTranscludeRef({ db: db({ b: null }), fga: fga(true) }, { principal: 'user:u', refPageId: 'b' }))
      .toEqual({ ok: false, reason: 'denied' })
    expect(await resolveTranscludeRef({ db: db({}), fga: fga(true) }, { principal: 'user:u', refPageId: 'gone' }))
      .toEqual({ ok: false, reason: 'denied' })
  })

  it('stops on a cycle/depth before any authz or fetch', async () => {
    const r = await resolveTranscludeRef({ db: db({ b: 'x' }), fga: fga(true) }, { principal: 'user:u', refPageId: 'b', chain: ['b'] })
    expect(r).toEqual({ ok: false, reason: 'cycle' })
  })
})

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

// #325 / ADR-137 slice 1: a `pageId#slug` fragment extracts ONE section AFTER the page-level view gate.
describe('resolveTranscludeRef section fragments (#325 / ADR-137)', () => {
  const doc = '# Intro\n\nintro body\n\n## Details\n\ndetail body\n\n# Other\n\nother body\n'

  it('a viewer gets just the requested section (heading line through the next same-or-higher heading)', async () => {
    const r = await resolveTranscludeRef({ db: db({ b: doc }), fga: fga(true) }, { principal: 'user:u', refPageId: 'b#details' })
    expect(r).toEqual({ ok: true, content: '## Details\n\ndetail body' })
  })

  it('a top-level section stops at the next same-level heading (its subsections stay in)', async () => {
    const r = await resolveTranscludeRef({ db: db({ b: doc }), fga: fga(true) }, { principal: 'user:u', refPageId: 'b#intro' })
    expect(r).toEqual({ ok: true, content: '# Intro\n\nintro body\n\n## Details\n\ndetail body' })
  })

  it('an UNKNOWN slug is byte-identical to a denied page (no fragment-existence oracle)', async () => {
    const r = await resolveTranscludeRef({ db: db({ b: doc }), fga: fga(true) }, { principal: 'user:u', refPageId: 'b#no-such-section' })
    expect(r).toEqual({ ok: false, reason: 'denied' })
  })

  it('#325 slice 2: a `#^id` block fragment resolves the enclosing block (marker stripped)', async () => {
    const bdoc = '# Intro\n\nintro body\n\ntarget paragraph ^myblk\n\n# Other\n'
    const r = await resolveTranscludeRef({ db: db({ b: bdoc }), fga: fga(true) }, { principal: 'user:u', refPageId: 'b#^myblk' })
    expect(r).toEqual({ ok: true, content: 'target paragraph' })
  })

  it('#325 slice 2: an UNKNOWN `#^id` is byte-identical to a denied page (no block-existence oracle)', async () => {
    const r = await resolveTranscludeRef({ db: db({ b: doc }), fga: fga(true) }, { principal: 'user:u', refPageId: 'b#^nope' })
    expect(r).toEqual({ ok: false, reason: 'denied' })
  })

  it('the fragment NEVER smuggles a different identity: cycle/authz key on the bare page id', async () => {
    // cycle: chain has bare 'b' → a fragment ref to the same page is still the same node.
    expect(await resolveTranscludeRef({ db: db({ b: doc }), fga: fga(true) }, { principal: 'user:u', refPageId: 'b#intro', chain: ['b'] }))
      .toEqual({ ok: false, reason: 'cycle' })
    // authz: a non-viewer of 'b' is denied even with a fragment, and the content is never read.
    let read = false
    const tracking = { sql: async () => { read = true; return [{ published_md: doc }] } } as never
    expect(await resolveTranscludeRef({ db: tracking, fga: fga(false) }, { principal: 'user:u', refPageId: 'b#intro' }))
      .toEqual({ ok: false, reason: 'denied' })
    expect(read).toBe(false)
  })
})

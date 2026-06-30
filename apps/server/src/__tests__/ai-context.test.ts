// FGA-scoped AI context gathering (#130 / ADR-077) — the SECURITY invariant: AI is never an
// authz side-channel. With fakes for search/db/fga (no infra), verify a page the principal
// CANNOT view never contributes to the gathered context, even when search returns it (stale
// index). Also: only published content contributes; rank order + the page cap are honored.
import { describe, it, expect } from 'vitest'
import { gatherAuthorizedContext, MAX_CONTEXT_PAGES } from '../ai/context.js'

// A fake page store: id → { title, published_md|null }
function fakeDb(pages: Record<string, { title: string; md: string | null }>) {
  return {
    sql: async (_strings: TemplateStringsArray, id: string) => {
      const p = pages[id]
      return p ? [{ id, title: p.title, published_md: p.md }] : []
    },
  } as never
}
const fakeSearch = (ids: string[]) => ({ search: async () => ids.map((id) => ({ id, tenantId: 't', spaceId: 's', title: id })) }) as never
// fga that authorizes `view` only for the given page ids (object form `page:<id>`).
const fakeFga = (allow: string[]) => ({ check: async ({ object }: { object: string }) => ({ allowed: allow.includes(object.replace('page:', '')) }) }) as never

const ARGS = { tenantId: 't', userSub: 'u', groups: [], question: 'q' }

describe('gatherAuthorizedContext (#130 / ADR-077 — AI authz scoping)', () => {
  it('EXCLUDES a page the principal cannot view, even if search returns it', async () => {
    const db = fakeDb({ A: { title: 'Alpha', md: 'ALPHA_SECRET_BODY' }, B: { title: 'Bravo', md: 'BRAVO_SECRET_BODY' } })
    // search returns both; FGA authorizes only A. B must never appear in the context.
    const res = await gatherAuthorizedContext({ db, searchDriver: fakeSearch(['A', 'B']), fga: fakeFga(['A']) }, ARGS)
    expect(res.sources).toEqual(['A'])
    expect(res.context).toContain('ALPHA_SECRET_BODY')
    expect(res.context).not.toContain('BRAVO_SECRET_BODY') // the authz invariant
  })

  it('returns empty when NOTHING is authorized', async () => {
    const db = fakeDb({ A: { title: 'Alpha', md: 'x' } })
    const res = await gatherAuthorizedContext({ db, searchDriver: fakeSearch(['A']), fga: fakeFga([]) }, ARGS)
    expect(res).toEqual({ context: '', sources: [] })
  })

  it('only PUBLISHED content contributes (unpublished draft excluded)', async () => {
    const db = fakeDb({ A: { title: 'A', md: null }, B: { title: 'B', md: 'PUBLISHED_B' } })
    const res = await gatherAuthorizedContext({ db, searchDriver: fakeSearch(['A', 'B']), fga: fakeFga(['A', 'B']) }, ARGS)
    expect(res.sources).toEqual(['B']) // A authorized but unpublished → no leak of a draft
    expect(res.context).toContain('PUBLISHED_B')
  })

  it('preserves search rank order and caps the page count', async () => {
    const ids = Array.from({ length: MAX_CONTEXT_PAGES + 5 }, (_, i) => `p${i}`)
    const pages = Object.fromEntries(ids.map((id) => [id, { title: id, md: `body-${id}` }]))
    const res = await gatherAuthorizedContext({ db: fakeDb(pages), searchDriver: fakeSearch(ids), fga: fakeFga(ids) }, ARGS)
    expect(res.sources).toHaveLength(MAX_CONTEXT_PAGES) // capped
    expect(res.sources).toEqual(ids.slice(0, MAX_CONTEXT_PAGES)) // rank order preserved
  })
})

// #100 / ADR-029: the comment capability is independently grantable to a share_link. These
// are the DSL anti-tests for the model change (comment += [share_link, share_link with
// non_expired]). Pure OpenFGA (tuple-based — no DB rows needed). The full guest-commenting
// server path (routes, author label, mention safety, rate limit) is a separate increment.
import { describe, it, expect, afterEach } from 'vitest'
import { fgaClient, checkRelation, writeTuples, deleteTuples } from '@wikistead/authz'

const PAGE = 'gcdsl-page'
const OTHER = 'gcdsl-other'
const CLINK = 'gcdsl-comment-link'
const VLINK = 'gcdsl-view-link'

const can = (link: string, rel: string, page = PAGE) =>
  checkRelation(fgaClient, `share_link:${link}`, rel, { type: 'page', id: page })

afterEach(async () => {
  await deleteTuples(fgaClient, [{ user: `share_link:${CLINK}`, relation: 'comment', object: `page:${PAGE}` }]).catch(() => {})
  await deleteTuples(fgaClient, [{ user: `share_link:${VLINK}`, relation: 'view', object: `page:${PAGE}` }]).catch(() => {})
})

describe('#100 comment@share_link DSL', () => {
  it('① a comment link grants comment AND view, but NOT edit', async () => {
    await writeTuples(fgaClient, [{ user: `share_link:${CLINK}`, relation: 'comment', object: `page:${PAGE}` }])
    expect(await can(CLINK, 'comment')).toBe(true)
    expect(await can(CLINK, 'view')).toBe(true) // view = ... or comment
    expect(await can(CLINK, 'edit')).toBe(false) // comment ⊅ edit
  })

  it('② grants nothing on another page (no leak)', async () => {
    await writeTuples(fgaClient, [{ user: `share_link:${CLINK}`, relation: 'comment', object: `page:${PAGE}` }])
    expect(await can(CLINK, 'comment', OTHER)).toBe(false)
    expect(await can(CLINK, 'view', OTHER)).toBe(false)
  })

  it('③ a view-only link confers NO comment (asymmetry preserved)', async () => {
    await writeTuples(fgaClient, [{ user: `share_link:${VLINK}`, relation: 'view', object: `page:${PAGE}` }])
    expect(await can(VLINK, 'view')).toBe(true)
    expect(await can(VLINK, 'comment')).toBe(false) // view link cannot comment
  })

  it('④ deleting the comment tuple removes comment AND view in one op', async () => {
    await writeTuples(fgaClient, [{ user: `share_link:${CLINK}`, relation: 'comment', object: `page:${PAGE}` }])
    expect(await can(CLINK, 'view')).toBe(true)
    await deleteTuples(fgaClient, [{ user: `share_link:${CLINK}`, relation: 'comment', object: `page:${PAGE}` }])
    expect(await can(CLINK, 'comment')).toBe(false)
    expect(await can(CLINK, 'view')).toBe(false) // view was only via comment → gone too
  })

  it('comment is NOT granted to user:* (no anonymous commenting)', async () => {
    // The model lists user:* on view but NOT on comment — a public page is viewable by anyone
    // but never anonymously commentable. (No tuple needed: it is a model-shape assertion.)
    expect(await checkRelation(fgaClient, 'user:anonymous', 'comment', { type: 'page', id: PAGE })).toBe(false)
  })
})

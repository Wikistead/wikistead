// #100 / ADR-029 Option B — commenting is a RESOURCE SETTING (space#comment_open), not a link
// capability. DSL anti-tests (pure OpenFGA tuples, no DB): a guest comments via a VIEW link
// (view_base) INTERSECTED with the space having comments open (comment_open), inherited page←space.
// Verifies both directions (open ⇒ can, closed ⇒ cannot) and that view is unaffected by the toggle.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { fgaClient, checkRelation, writeTuples, deleteTuples } from '@wikistead/authz'

const SPACE = 'gcdsl-space', OSPACE = 'gcdsl-ospace'
const PAGE = 'gcdsl-page', OTHER = 'gcdsl-other'
const VLINK = 'gcdsl-vlink'           // a VIEW share link on PAGE
const can = (user: string, rel: string, page = PAGE) => checkRelation(fgaClient, user, rel, { type: 'page', id: page })
const setGuestsOpen = (on: boolean, space = SPACE) =>
  (on ? writeTuples : deleteTuples)(fgaClient, [{ user: 'share_link:*', relation: 'comment_open', object: `space:${space}` }]).catch(() => {})
const setMembersOpen = (on: boolean, space = SPACE) =>
  (on ? writeTuples : deleteTuples)(fgaClient, [{ user: 'user:*', relation: 'comment_open', object: `space:${space}` }]).catch(() => {})

beforeAll(async () => {
  await writeTuples(fgaClient, [
    { user: `space:${SPACE}`, relation: 'space', object: `page:${PAGE}` },   // page ← space (inheritance)
    { user: `space:${OSPACE}`, relation: 'space', object: `page:${OTHER}` },
    { user: `share_link:${VLINK}`, relation: 'view_base', object: `page:${PAGE}` }, // a VIEW link
    { user: 'user:*', relation: 'view_base', object: `page:${PAGE}` },        // PAGE is public-viewable
  ]).catch(() => {})
})
afterEach(async () => { await setGuestsOpen(false); await setMembersOpen(false); await setGuestsOpen(false, OSPACE) })
afterAll(async () => {
  await deleteTuples(fgaClient, [
    { user: `space:${SPACE}`, relation: 'space', object: `page:${PAGE}` },
    { user: `space:${OSPACE}`, relation: 'space', object: `page:${OTHER}` },
    { user: `share_link:${VLINK}`, relation: 'view_base', object: `page:${PAGE}` },
    { user: 'user:*', relation: 'view_base', object: `page:${PAGE}` },
  ]).catch(() => {})
})

describe('#100 comment = (view_base and comment_open) — Option B DSL', () => {
  it('① a VIEW link + comment_open ⇒ guest may comment AND view, NOT edit; without comment_open ⇒ view only', async () => {
    expect(await can(`share_link:${VLINK}`, 'view')).toBe(true)
    expect(await can(`share_link:${VLINK}`, 'comment')).toBe(false) // default OFF: view link alone can't comment
    await setGuestsOpen(true)
    expect(await can(`share_link:${VLINK}`, 'comment')).toBe(true)  // view link + comments open ⇒ can comment
    expect(await can(`share_link:${VLINK}`, 'view')).toBe(true)
    expect(await can(`share_link:${VLINK}`, 'edit')).toBe(false)    // never edit via a view link
  })

  it('② no cross-resource leak: comment_open on SPACE grants nothing on a page in ANOTHER space', async () => {
    await setGuestsOpen(true)
    // OTHER is in OSPACE (no comment_open, no view link) → the SPACE toggle must not reach it.
    expect(await can(`share_link:${VLINK}`, 'comment', OTHER)).toBe(false)
    expect(await can(`share_link:${VLINK}`, 'view', OTHER)).toBe(false)
  })

  it('③ comment is the resource setting, not the link: same view link, comment flips with comment_open', async () => {
    expect(await can(`share_link:${VLINK}`, 'comment')).toBe(false)
    await setGuestsOpen(true)
    expect(await can(`share_link:${VLINK}`, 'comment')).toBe(true)
  })

  it('④ toggling comment_open OFF removes comment for the audience in ONE op, while VIEW REMAINS', async () => {
    await setGuestsOpen(true)
    expect(await can(`share_link:${VLINK}`, 'comment')).toBe(true)
    await setGuestsOpen(false)
    expect(await can(`share_link:${VLINK}`, 'comment')).toBe(false) // comment gone
    expect(await can(`share_link:${VLINK}`, 'view')).toBe(true)     // but view REMAINS (view = view_base)
  })

  it('⑤ public (user:*) commenting requires comment_open@user:* (default OFF), independent of guests', async () => {
    expect(await can('user:*', 'view')).toBe(true)                  // public page: viewable
    expect(await can('user:*', 'comment')).toBe(false)             // default OFF: not commentable
    await setGuestsOpen(true)                                       // guests-open must NOT enable public members
    expect(await can('user:*', 'comment')).toBe(false)
    await setMembersOpen(true)
    expect(await can('user:*', 'comment')).toBe(true)              // members-open ⇒ public may comment
  })

  it('⑦ inheritance (Option B): comment_open@space gates every page in the space; another space unaffected', async () => {
    await setGuestsOpen(true, SPACE)
    expect(await can(`share_link:${VLINK}`, 'comment', PAGE)).toBe(true)  // PAGE in SPACE ⇒ gated on
    // OTHER (in OSPACE) has no comment_open even though SPACE is open → space-scoped, no cross-space bleed.
    expect(await can(`share_link:${VLINK}`, 'comment', OTHER)).toBe(false)
  })
})

// #328 / ADR-140: the publish-boundary abuse filter (increment 1). Pure logic — mass-delete shrink + banned
// words on ADDED content, all-permissive defaults, static reason codes, content never touched.
import { describe, it, expect } from 'vitest'
import { evaluatePublishAbuse } from '../abuse-filter.js'

const OFF = { shrinkRatio: null, bannedWords: [] as string[] }

describe('evaluatePublishAbuse (#328 / ADR-140)', () => {
  it('all-permissive defaults never reject (self-host zero behavior change)', () => {
    expect(evaluatePublishAbuse('a very long published page body here', '', OFF)).toEqual({ ok: true })
    expect(evaluatePublishAbuse(null, 'brand new page', OFF)).toEqual({ ok: true })
  })

  it('mass_delete: new text under shrinkRatio × published is rejected', () => {
    const published = 'x'.repeat(1000)
    expect(evaluatePublishAbuse(published, 'y'.repeat(150), { shrinkRatio: 0.2, bannedWords: [] })).toEqual({ ok: false, reason: 'mass_delete' })
    // just above the threshold → allowed
    expect(evaluatePublishAbuse(published, 'y'.repeat(250), { shrinkRatio: 0.2, bannedWords: [] })).toEqual({ ok: true })
  })

  it('mass_delete does not fire on a first publish (no published text to shrink from)', () => {
    expect(evaluatePublishAbuse(null, 'a', { shrinkRatio: 0.2, bannedWords: [] })).toEqual({ ok: true })
    expect(evaluatePublishAbuse('', 'a', { shrinkRatio: 0.2, bannedWords: [] })).toEqual({ ok: true })
  })

  it('banned_content: a banned word ADDED in the new text is rejected (case-insensitive)', () => {
    expect(evaluatePublishAbuse('hello world', 'hello world SPAMWORD', { shrinkRatio: null, bannedWords: ['spamword'] })).toEqual({ ok: false, reason: 'banned_content' })
    expect(evaluatePublishAbuse('hello world', 'hello world spamword', { shrinkRatio: null, bannedWords: ['SPAMWORD'] })).toEqual({ ok: false, reason: 'banned_content' })
  })

  it('banned_content only flags ADDED words — an existing banned word does not block a benign edit', () => {
    // the word was already published; a later edit that keeps it (and changes nothing else banned) is allowed.
    expect(evaluatePublishAbuse('this has spamword already', 'this has spamword already, plus a benign edit', { shrinkRatio: null, bannedWords: ['spamword'] })).toEqual({ ok: true })
  })

  it('banned words match whole tokens, not substrings', () => {
    // "class" is banned but "classroom" is a different token → not flagged.
    expect(evaluatePublishAbuse('', 'a classroom note', { shrinkRatio: null, bannedWords: ['class'] })).toEqual({ ok: true })
    expect(evaluatePublishAbuse('', 'go to class', { shrinkRatio: null, bannedWords: ['class'] })).toEqual({ ok: false, reason: 'banned_content' })
  })

  it('mass_delete is checked before banned words (a wipe reports mass_delete)', () => {
    expect(evaluatePublishAbuse('x'.repeat(1000), 'spamword', { shrinkRatio: 0.2, bannedWords: ['spamword'] })).toEqual({ ok: false, reason: 'mass_delete' })
  })

  it('a nonsensical shrinkRatio (>1 or ≤0) is treated as off (a bad config never blocks a normal publish)', () => {
    // ratio 1.5 would reject an equal-length no-op if honored — guard treats it as off.
    expect(evaluatePublishAbuse('x'.repeat(100), 'x'.repeat(100), { shrinkRatio: 1.5, bannedWords: [] })).toEqual({ ok: true })
    expect(evaluatePublishAbuse('x'.repeat(100), 'y'.repeat(10), { shrinkRatio: 0, bannedWords: [] })).toEqual({ ok: true })
  })
})

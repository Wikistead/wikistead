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

// #531: the filter matched banned words as WHOLE TOKENS only. Japanese/Chinese/Korean are not written with
// spaces, so is a single token and banning never fired — the moderation surface was
// effectively off for those languages. Ruled fix: the matching mode follows the banned WORD's script.
describe('#531 banned words in non-word-segmented scripts (CJK → substring, Latin → token)', () => {
  const ban = (...words: string[]) => ({ shrinkRatio: null, bannedWords: words })

  it('the reported case: banning 「ほげ」 rejects 「ほげほげです。」', () => {
    expect(evaluatePublishAbuse(null, 'ほげほげです。', ban('ほげ'))).toEqual({ ok: false, reason: 'banned_content' })
  })

  it('and the bare word is still rejected (the case that always worked stays working)', () => {
    expect(evaluatePublishAbuse(null, 'ほげ', ban('ほげ'))).toEqual({ ok: false, reason: 'banned_content' })
    expect(evaluatePublishAbuse(null, 'これは ほげ です', ban('ほげ'))).toEqual({ ok: false, reason: 'banned_content' })
  })

  it('a CJK word inside running text with no spaces at all is caught', () => {
    expect(evaluatePublishAbuse(null, '今日は良い天気なので出かけますが宣伝文句もあります', ban('宣伝'))).toEqual({ ok: false, reason: 'banned_content' })
    expect(evaluatePublishAbuse(null, '广告内容在这里', ban('广告'))).toEqual({ ok: false, reason: 'banned_content' })
    expect(evaluatePublishAbuse(null, '이것은광고입니다', ban('광고'))).toEqual({ ok: false, reason: 'banned_content' })
  })

  it('Latin words keep WORD-BOUNDARY matching — no Scunthorpe false positives', () => {
    // the whole reason Latin is not switched to substring: a substring rule would flag every "classic".
    expect(evaluatePublishAbuse(null, 'a classic assessment of the passage', ban('ass'))).toEqual({ ok: true })
    expect(evaluatePublishAbuse(null, 'that is ass', ban('ass'))).toEqual({ ok: false, reason: 'banned_content' })
  })

  it('a mixed list judges each word by its own script', () => {
    const cfg = ban('spam', 'スパム')
    expect(evaluatePublishAbuse(null, 'これはスパムメールです', cfg)).toEqual({ ok: false, reason: 'banned_content' })
    expect(evaluatePublishAbuse(null, 'this is spam', cfg)).toEqual({ ok: false, reason: 'banned_content' })
    expect(evaluatePublishAbuse(null, 'this is spamalot', cfg), 'the Latin word still needs its boundary').toEqual({ ok: true })
    expect(evaluatePublishAbuse(null, '普通の文章です', cfg)).toEqual({ ok: true })
  })

  it('ADDED-only holds for CJK too: an already-published banned word does not block a later edit', () => {
    // the I3 semantics the Latin path has always had, carried to substring matching by OCCURRENCE COUNT.
    expect(evaluatePublishAbuse('ほげほげです。', 'ほげほげです。追記しました。', ban('ほげ'))).toEqual({ ok: true })
    // …and removing an occurrence is obviously fine
    expect(evaluatePublishAbuse('ほげ ほげ', 'ほげ', ban('ほげ'))).toEqual({ ok: true })
  })

  it('but ADDING one more occurrence to a page that already had it IS rejected', () => {
    // the count is what makes "added" meaningful without word boundaries — a fresh insertion must not hide
    // behind an existing one.
    expect(evaluatePublishAbuse('ほげ', 'ほげ ほげ', ban('ほげ'))).toEqual({ ok: false, reason: 'banned_content' })
  })

  it('a CJK word not present at all still publishes (no over-blocking)', () => {
    expect(evaluatePublishAbuse('前の本文', '普通の日本語の文章です。', ban('ほげ', '宣伝'))).toEqual({ ok: true })
  })

  it('the union of a tenant floor and a space overlay (#509) enforces BOTH words', () => {
    // #509/ADR-187 resolves the effective policy as a union of word lists; the judge must apply each word's
    // own mode within that merged list.
    const union = ban('spam', 'ほげ') // floor: spam / overlay:
    expect(evaluatePublishAbuse(null, 'ほげほげです。', union)).toEqual({ ok: false, reason: 'banned_content' })
    expect(evaluatePublishAbuse(null, 'buy spam now', union)).toEqual({ ok: false, reason: 'banned_content' })
  })

  it('shrink-ratio judging is untouched by the word-matching change', () => {
    const published = 'あ'.repeat(1000)
    expect(evaluatePublishAbuse(published, 'い'.repeat(150), { shrinkRatio: 0.2, bannedWords: ['ほげ'] })).toEqual({ ok: false, reason: 'mass_delete' })
    expect(evaluatePublishAbuse(published, 'い'.repeat(250), { shrinkRatio: 0.2, bannedWords: ['ほげ'] })).toEqual({ ok: true })
  })
})

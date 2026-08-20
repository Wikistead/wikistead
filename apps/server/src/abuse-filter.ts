// #328 / ADR-140: the publish-boundary abuse filter (increment 1). Evaluated inside publishPage where BOTH the
// new draft (`md`) and the currently-published text (`publishedMd`) are in hand. It only DECIDES — it never
// edits content (the single Y.Text / CRDT is untouched) and never interpolates content/words/lengths into the
// outcome (a STATIC reason code; and the `edit` gate has already run, so a rejected author can already read the
// page — no authorization oracle, reviewer condition I2). Defaults are all-permissive, so a self-host tenant
// with the knobs unset gets zero behavior change and zero overhead (reviewer I1: raw IP is never used here — the
// rate cap increment keys on share-link / session id, a separate surface).

export interface AbuseConfig {
  // Mass-delete detection: reject a publish whose new text is smaller than `shrinkRatio` × the published text
  // (e.g. 0.2 → reject when the new page is under 20% of the old). NULL = off (default). Only fires when there
  // is published text to shrink from.
  readonly shrinkRatio: number | null
  // Banned words: a flag fires only when a banned word is ADDED, so a benign edit to a page that already
  // contains a flagged word is not blocked and an existing word is not re-flagged (reviewer I3). How a word
  // is matched follows the word's own script (#531): CJK words match as SUBSTRINGS (those languages are not
  // word-segmented) and "added" then means a HIGHER OCCURRENCE COUNT than the published text; every other
  // word matches whole tokens and "added" means absent from the published token set. Empty = off (default).
  readonly bannedWords: readonly string[]
}

export type AbuseVerdict = { ok: true } | { ok: false; reason: 'mass_delete' | 'banned_content' }

// A "word" token: Unicode letters/numbers/underscore runs. Case-insensitive matching (lowercased).
const WORD_RE = /[\p{L}\p{N}_]+/gu

function tokenSet(s: string): Set<string> {
  const set = new Set<string>()
  for (const m of s.toLowerCase().matchAll(WORD_RE)) set.add(m[0])
  return set
}

// #531: banned words were matched ONLY as whole tokens, and Japanese/Chinese/Korean are not written with
// spaces — so a phrase like "hogehogedesu" is ONE token and banning "hoge" never fired. The filter was effectively dead for
// non-word-segmented languages, which is the moderation surface's whole point. Ruled fix: pick the matching
// mode from the WORD's own script, so nobody has to configure it.
//   - a word containing CJK  → SUBSTRING match (banning "hoge" catches a "hogehogedesu" phrase containing it)
//   - a Latin-only word      → token match, unchanged (banning "ass" must not flag "classic" — Scunthorpe)
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const isSubstringWord = (w: string): boolean => CJK_RE.test(w)

// Non-overlapping occurrence count of `needle` in `hay` (both already lowercased).
function countOccurrences(hay: string, needle: string): number {
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n += 1
  return n
}

// Evaluate the publish against the tenant's abuse policy. Pure — no I/O. Returns `{ ok: true }` when nothing
// trips (the common case, and always for an all-permissive config).
export function evaluatePublishAbuse(publishedMd: string | null, md: string, config: AbuseConfig): AbuseVerdict {
  // Mass-delete: cheap length ratio vs the published text. Only when the knob is on AND there is published text.
  // Guard the ratio to (0, 1] — a nonsensical config (>1 would reject even an equal-length no-op republish; ≤0
  // is a no-op) is treated as off, so a bad setting can never block a normal publish (there is no config UI in
  // this increment; the config surface increment will range-validate at the input).
  if (config.shrinkRatio != null && config.shrinkRatio > 0 && config.shrinkRatio <= 1 && publishedMd != null && publishedMd.length > 0 && md.length < publishedMd.length * config.shrinkRatio) {
    return { ok: false, reason: 'mass_delete' }
  }
  // Banned words on ADDED content only. Two modes, chosen per word by its script (#531).
  if (config.bannedWords.length > 0) {
    const banned = [...new Set(config.bannedWords.map((w) => w.toLowerCase()).filter((w) => w.length > 0))]
    if (banned.length > 0) {
      const after = md.toLowerCase()
      const beforeText = (publishedMd ?? '').toLowerCase()
      const tokenBanned = new Set(banned.filter((w) => !isSubstringWord(w)))
      const substringBanned = banned.filter(isSubstringWord)

      // Token mode (Latin & friends): unchanged token-set difference — a word already in the published text
      // is not re-flagged, so an unrelated edit to a page that already contains it still publishes (I3).
      if (tokenBanned.size > 0) {
        const before = publishedMd ? tokenSet(publishedMd) : new Set<string>()
        for (const m of after.matchAll(WORD_RE)) {
          if (tokenBanned.has(m[0]) && !before.has(m[0])) return { ok: false, reason: 'banned_content' }
        }
      }

      // Substring mode (CJK): "already present" cannot be decided per token here, so ADDED is defined by
      // OCCURRENCE COUNT — the publish is rejected only when the new text contains the word MORE times than
      // the published one did. That keeps the added-only semantics intact (republishing a page that already
      // says it, or even removing occurrences, still goes through) while catching every fresh insertion.
      for (const w of substringBanned) {
        if (countOccurrences(after, w) > countOccurrences(beforeText, w)) return { ok: false, reason: 'banned_content' }
      }
    }
  }
  return { ok: true }
}

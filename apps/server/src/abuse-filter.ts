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
  // Banned words: a flag fires only when a banned word is ADDED (present in the new text but not the published
  // text — a token-set difference), so a benign edit to a page that already contains a flagged word is not
  // blocked and an existing word is not re-flagged (reviewer I3). Empty = off (default).
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
  // Banned words on ADDED content only (token-set difference).
  if (config.bannedWords.length > 0) {
    const banned = new Set(config.bannedWords.map((w) => w.toLowerCase()).filter((w) => w.length > 0))
    if (banned.size > 0) {
      const before = publishedMd ? tokenSet(publishedMd) : new Set<string>()
      for (const m of md.toLowerCase().matchAll(WORD_RE)) {
        if (banned.has(m[0]) && !before.has(m[0])) return { ok: false, reason: 'banned_content' }
      }
    }
  }
  return { ok: true }
}

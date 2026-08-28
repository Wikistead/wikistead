// #1006 / ADR-260 §3.3 / §6.4 / §7 item 2: the vocabulary both apps/web and apps/server read, moved
// here because apps/server must not depend on @wikistead/web (an existing invariant) and this package
// is the edge both already cross (apps/web and apps/server both already depend on
// @wikistead/macro-render; this is that edge's small sibling, not a new one).

// The supported locale set. apps/web's i18n/index.ts and apps/server's locale.ts both re-export this
// rather than declaring their own copy — a second list is exactly the drift ADR-260 §2 forbids, now
// for locale CODES rather than prose.
export const LANGS = ['en', 'ja'] as const
export type Lang = (typeof LANGS)[number]

export function isKnownLang(v: string | null | undefined): v is Lang {
  return v != null && (LANGS as readonly string[]).includes(v)
}

// #900: the six values apps/server's `fanOutFeedEvent` actually writes to `feed_events.event_type`,
// as a union rather than a bare string — a seventh kind added tomorrow is a compile error here until
// somebody gives it words, in both languages, rather than shipping the raw identifier to a mail body.
export type FeedEventType =
  | 'page.published'
  | 'page.restored'
  | 'page.made_public'
  | 'page.made_non_public'
  | 'comment.created'
  | 'attachment.confirmed'

// The SAME words apps/web already shows on AccountPage/WatchListPage under `eventTypes.<type>`
// (i18next resolves the dot path against the nested locale JSON) — copied here verbatim, not
// re-translated, because a mail is not the place to invent a second English or a second Japanese for
// an event the reader already has a name for on screen. apps/web/src/i18n/vocabulary-sync-1006.test.ts
// pins these against the locale JSON so the two cannot drift silently (the JSON keeps its own copy
// no-orphan-keys-645's own self-test reads eventTypes.page.published out of the raw file, so that copy
// cannot be replaced by an import without changing what that pin protects).
export const EVENT_TYPE_LABELS: Record<Lang, Record<FeedEventType, string>> = {
  en: {
    'page.published': 'Page published',
    'page.restored': 'Page restored',
    'page.made_public': 'Page made public',
    'page.made_non_public': 'Page made non-public',
    'comment.created': 'New comment',
    'attachment.confirmed': 'File attached',
  },
  ja: {
    'page.published': 'ページの公開',
    'page.restored': 'ページの復元',
    'page.made_public': 'ページの一般公開',
    'page.made_non_public': '一般公開の解除',
    'comment.created': '新しいコメント',
    'attachment.confirmed': 'ファイル添付',
  },
}

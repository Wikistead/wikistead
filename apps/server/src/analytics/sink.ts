// #688 slice 2: the CE side of page analytics — a registration point with no collector behind it.
// Collection, roll-up dashboards, retention GC and the DSAR erase are organisational governance and
// live in @wikistead-ee/server (the same line the audit ledger moved behind). The CE routes that can
// OBSERVE a read (the public page render, the reading surface's explicit view signal) report the raw
// event here; whether anything is recorded — entitlement, dedup hashing, day bucketing, the roster —
// is entirely the registered collector's business. A CE build registers nothing and records nothing.
//
// ⚠️ The anonymous event passes the IP, not a hash: hashing is part of the privacy machinery that
// moved. The facade forwards and forgets; only the EE collector derives the dedup key, and nothing
// stores an IP (ADR-175 §4).

export type PageViewEvent = {
  tenant: { id: string; plan: string }
  pageId: string
} & (
  | { viewerClass: 'anon'; ip: string }
  | { viewerClass: 'member'; memberSub: string; dedupKey: string }
  | { viewerClass: 'guest'; dedupKey: string }
)

export type PageViewCollector = (event: PageViewEvent) => Promise<void>

let collector: PageViewCollector | null = null

export function registerPageViewCollector(c: PageViewCollector): void {
  collector = c
}

/** True when an analytics feature is composed in — the admin-surfaces nav filter reads this. */
export function analyticsRegistered(): boolean {
  return collector !== null
}

export async function collectPageViewEvent(event: PageViewEvent): Promise<void> {
  if (collector) await collector(event)
}

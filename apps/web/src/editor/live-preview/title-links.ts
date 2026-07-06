// #224 / ADR-104: match body text against a page-title dictionary → the ranges to linkify. This is the
// MIS-MATCH SUPPRESSION + matching core (ADR-104 point 3), which is UX-only and carries NO authz: the caller
// passes a dictionary that has ALREADY been filtered to the viewer's authorized pages (search viewer
// denormalisation) and re-confirms `view` at display time. This pure function only decides WHICH authorized
// titles become links and where — never whether a page is visible. Pure → unit-tested directly.

export interface TitleEntry {
  readonly title: string;
  readonly pageId: string;
}
export interface TitleMatch {
  readonly from: number;
  readonly to: number;
  readonly pageId: string;
  readonly title: string;
}

const isWordChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_]/u.test(c);
// A CJK title has no word boundaries (Japanese is written without spaces), so it matches as a substring;
// a latin title must sit on word boundaries so "cat" doesn't light up inside "concatenate".
const hasCjk = (s: string): boolean => /[぀-ヿ㐀-鿿ｦ-ﾟ]/u.test(s);

export interface MatchOpts {
  readonly minLen?: number; // min latin title length (default 4 — avoid noise like "the")
  readonly minCjkLen?: number; // min CJK title length (default 2)
  readonly stopWords?: ReadonlySet<string>; // tenant stop list (lower-cased), never linkified
  readonly firstPerPage?: boolean; // link only the FIRST occurrence of each target page (default true)
}

// Returns the non-overlapping link ranges, longest-title-first (longest-match-wins so a title that is a
// substring of a longer matched title never double-links), sorted by position.
export function matchTitleLinks(text: string, dict: readonly TitleEntry[], opts: MatchOpts = {}): TitleMatch[] {
  const minLen = opts.minLen ?? 4;
  const minCjkLen = opts.minCjkLen ?? 2;
  const firstPerPage = opts.firstPerPage ?? true;
  const stop = opts.stopWords;

  const entries = dict
    .map((e) => ({ ...e, t: e.title.trim() }))
    .filter((e) => {
      if (!e.t) return false;
      if (stop?.has(e.t.toLowerCase())) return false;
      return hasCjk(e.t) ? e.t.length >= minCjkLen : e.t.length >= minLen;
    })
    .sort((a, b) => b.t.length - a.t.length); // longest first → longest-match-wins

  const claimed = new Array<boolean>(text.length).fill(false);
  const seenPage = new Set<string>();
  const lower = text.toLowerCase();
  const matches: TitleMatch[] = [];

  for (const e of entries) {
    if (firstPerPage && seenPage.has(e.pageId)) continue;
    const needle = e.t.toLowerCase();
    const cjk = hasCjk(e.t);
    let idx = lower.indexOf(needle);
    while (idx !== -1) {
      const to = idx + needle.length;
      const boundaryOk = cjk || (!isWordChar(text[idx - 1]) && !isWordChar(text[to]));
      let overlaps = false;
      for (let i = idx; i < to; i++) if (claimed[i]) { overlaps = true; break; }
      if (boundaryOk && !overlaps) {
        matches.push({ from: idx, to, pageId: e.pageId, title: e.t });
        for (let i = idx; i < to; i++) claimed[i] = true;
        seenPage.add(e.pageId);
        if (firstPerPage) break; // this page is done
      }
      idx = lower.indexOf(needle, to);
    }
  }
  return matches.sort((a, b) => a.from - b.from);
}

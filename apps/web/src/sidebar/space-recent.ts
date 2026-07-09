import type { Space } from "../data/queries";

// #263: the bounded space-switcher logic, kept free of React/cmdk imports so it is unit-testable in
// isolation (the SpaceSwitcher component re-exports these).

const RECENT_KEY = "wks:recent-spaces";
const DEFAULT_LIMIT = 8;

export function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Record a device-local "recently used" space (most-recent first, deduped). Server persistence is deferred
// until the need appears (#263 design memo).
export function recordRecentSpace(id: string): void {
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, 20);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable — recents are best-effort */
  }
}

// The bounded default set (empty query) OR the full filtered set (non-empty query, over ALL viewable
// spaces). #284: PINNED spaces come first (in pin order) and are exempt from the cap — a pinned space is
// always shown, never folded into "N more". Then the current space, recents (most-recent first), and the
// rest to fill the cap. `pinnedIds` is the member's server-persisted pin order (view-confirmed upstream).
export function visibleSpaces(spaces: Space[], currentId: string | undefined, query: string, pinnedIds: string[] = []): Space[] {
  const q = query.trim().toLowerCase();
  if (q) return spaces.filter((s) => (s.name || "").toLowerCase().includes(q));
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const out: Space[] = [];
  for (const id of pinnedIds) {
    const s = byId.get(id);
    if (s && !out.includes(s)) out.push(s);
  }
  const cur = currentId ? byId.get(currentId) : undefined;
  if (cur && !out.includes(cur)) out.push(cur);
  // The cap bounds the NON-pinned tail: pinned entries never consume it, so many pins
  // don't crowd out the current/recents section (and pins themselves are never cut).
  const cap = DEFAULT_LIMIT + pinnedIds.filter((id) => byId.has(id)).length;
  for (const id of readRecent()) {
    if (out.length >= cap) return out;
    if (id === currentId) continue;
    const s = byId.get(id);
    if (s && !out.includes(s)) out.push(s);
  }
  for (const s of spaces) {
    if (out.length >= cap) break;
    if (out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

// #263 rejection ①: how many viewable spaces are hidden by the bounded default list, so the switcher can
// tell the user "there are more — search to find them" instead of silently truncating. Zero while a query
// is active (search spans ALL viewable spaces, so nothing is hidden) and never negative.
export function hiddenSpaceCount(total: number, shown: number, query: string): number {
  if (query.trim()) return 0;
  return Math.max(0, total - shown);
}

// #287: the "show all" list — EVERY viewable space, NAME-sorted (case-insensitive) for browsing when you
// can't remember a name. Distinct from the bounded default (current + recents order): this is the full set
// to scan. Same server-FGA-filtered `spaces` set — no new fetch, no new permission surface.
export function allSpacesSorted(spaces: Space[]): Space[] {
  return [...spaces].sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
}

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
// spaces). Current space is always first; then recents (most-recent first); then the rest to fill the cap.
export function visibleSpaces(spaces: Space[], currentId: string | undefined, query: string): Space[] {
  const q = query.trim().toLowerCase();
  if (q) return spaces.filter((s) => (s.name || "").toLowerCase().includes(q));
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const out: Space[] = [];
  const cur = currentId ? byId.get(currentId) : undefined;
  if (cur) out.push(cur);
  for (const id of readRecent()) {
    if (id === currentId) continue;
    const s = byId.get(id);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= DEFAULT_LIMIT) return out;
  }
  for (const s of spaces) {
    if (out.includes(s)) continue;
    out.push(s);
    if (out.length >= DEFAULT_LIMIT) break;
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

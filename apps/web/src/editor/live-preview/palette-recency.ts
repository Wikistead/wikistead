// Light-2: the palette learns the user's recently-used commands and surfaces them at the
// top of the list. PURELY a personal convenience — stored in localStorage, never on the
// server / never in authz. A move-to-front recency list (most-recent first, capped); the
// reorder is STABLE: recently-used matches float up in recency order, everything else
// keeps its original order (so ties never shuffle). Per scope ("insert" / "decorate").

const KEY = (scope: string) => `wks.palette.recent.${scope}`;
const CAP = 6;

export function recentIds(scope: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(scope)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function recordUse(scope: string, id: string): void {
  try {
    const next = [id, ...recentIds(scope).filter((x) => x !== id)].slice(0, CAP);
    localStorage.setItem(KEY(scope), JSON.stringify(next));
  } catch {
    /* no storage (private mode) — recency is best-effort */
  }
}

// Stable reorder: recently-used items first (in recency order), then the rest in their
// original order. Never drops or duplicates items.
export function orderByRecency<T>(scope: string, items: T[], idOf: (t: T) => string): T[] {
  const rank = new Map(recentIds(scope).map((id, i) => [id, i] as const));
  const recent = items.filter((t) => rank.has(idOf(t))).sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
  const rest = items.filter((t) => !rank.has(idOf(t)));
  return [...recent, ...rest];
}

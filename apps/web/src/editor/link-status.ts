import type { LinkStatusResolver } from "./live-preview/decorations";

const API_URL = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? "/api";

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// #276 / ADR-117: host-side resolver behind the dead-internal-link overlay. The editor collects the doc's
// `/p/<id>` targets and asks this: "which can the viewer VIEW?" — it POSTs the ids to the gated
// /pages/link-status (a pure FGA `view` batch, NO existence query server-side) and returns the viewable
// subset. Everything absent is treated as dead by the overlay — the response never says WHY (existence-
// hiding: non-existent / deleted / private / cross-tenant are indistinguishable). Returns null to DEGRADE
// (any non-200 / network error / malformed body) → the overlay leaves every link ALIVE (never a false dead).
// The fetcher is injectable so the request/response mapping is unit-tested without a real network.
export function makeLinkStatusResolver(token: string, fetcher: Fetcher = fetch): LinkStatusResolver {
  return async (ids: string[]) => {
    if (!ids.length) return new Set<string>();
    try {
      const res = await fetcher(`${API_URL}/pages/link-status`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ ids }),
      });
      if (res.status !== 200) return null; // any non-200 → degrade (leave links alive)
      const data = (await res.json()) as { viewable?: unknown };
      if (!Array.isArray(data.viewable)) return null; // malformed → degrade
      return new Set(data.viewable.filter((x): x is string => typeof x === "string"));
    } catch {
      return null; // network failure → degrade (never a false "dead")
    }
  };
}

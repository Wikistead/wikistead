import { apiFetch } from "../data/apiClient";
import type { ImageResolver } from "./live-preview/decorations";

// Resolves a wks-attachment id → a fresh presigned download URL, with a small
// in-memory TTL cache so a page with the same image many times costs ONE resolve
// while the URL is valid. The download endpoint re-checks FGA `view` per call, so
// security is not weakened by caching — a revoked user simply gets a fresh 403 on
// the next (cache-miss/refresh) resolve. `refresh` bypasses the cache (used when
// an <img> errors because its presigned URL expired). Never persists the URL.
export function makeImageResolver(token: string): ImageResolver {
  const cache = new Map<string, { url: string; exp: number }>();
  return async (id, opts) => {
    const now = Date.now();
    const hit = cache.get(id);
    if (!opts?.refresh && hit && hit.exp > now) return hit.url;
    const res = await apiFetch<{ downloadUrl: string; expiresAt: string }>(
      `/attachments/${encodeURIComponent(id)}/download`,
      token,
    ).catch(() => null);
    if (!res) {
      cache.delete(id);
      return null;
    }
    // Expire our cache a little before the real TTL to avoid a guaranteed-stale hit.
    cache.set(id, { url: res.downloadUrl, exp: Date.parse(res.expiresAt) - 5_000 });
    return res.downloadUrl;
  };
}

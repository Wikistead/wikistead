import { apiFetch, assetUrl } from "../data/apiClient";
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

// #376 / ADR-149 §2: the ANONYMOUS public reader's image resolver — the /public sibling serves a
// presigned URL only when the owning page is ANON-viewable AND published (uniform 404 otherwise).
// Same TTL cache discipline as the member resolver; no token (public surface).
export function makePublicImageResolver(): ImageResolver {
  const cache = new Map<string, { url: string; exp: number }>();
  return async (id, opts) => {
    const now = Date.now();
    const hit = cache.get(id);
    if (!opts?.refresh && hit && hit.exp > now) return hit.url;
    try {
      const res = await fetch(assetUrl(`/public/attachments/${encodeURIComponent(id)}/download`));
      if (!res.ok) { cache.delete(id); return null; }
      const body = (await res.json()) as { downloadUrl: string; expiresAt: string };
      cache.set(id, { url: body.downloadUrl, exp: Date.parse(body.expiresAt) - 5_000 });
      return body.downloadUrl;
    } catch {
      cache.delete(id);
      return null;
    }
  };
}

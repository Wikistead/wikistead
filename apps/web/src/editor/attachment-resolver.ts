import { assetUrl, type Bearer, bearerValue} from "../data/apiClient";
import { apiFetch } from "../data/apiClient";
import type { AttachmentResolver, AttachmentMeta } from "./live-preview/decorations";

// #273 / ADR-120: resolves a [name](wks-attachment:<id>) file link for the editor widgets.
// meta() goes through the authenticated download endpoint (the server re-checks FGA `view`
// per call and returns the SERVER-SNIFFED inlineKind — never the client-declared type) with
// the same small TTL cache the image resolver uses. inlineUrl() fetches the PROXIED inline
// bytes (the nosniff/CSP route) WITH the caller's credentials and hands back a blob: URL —
// an <iframe src> can't carry an Authorization header itself, so the blob is how the
// sandboxed PDF viewer works for members (cookie or bearer) and guests (bearer) alike.
export function makeAttachmentResolver(token: Bearer): AttachmentResolver {
  const metaCache = new Map<string, { meta: AttachmentMeta; exp: number }>();
  const blobCache = new Map<string, string>(); // blob: URLs live until page unload (bytes are immutable)
  return {
    async meta(id) {
      const now = Date.now();
      const hit = metaCache.get(id);
      if (hit && hit.exp > now) return hit.meta;
      const res = await apiFetch<{ downloadUrl: string; filename: string; expiresAt: string; sizeBytes: number | null; inlineKind: AttachmentMeta["inlineKind"] }>(
        `/attachments/${encodeURIComponent(id)}/download`,
        token,
      ).catch(() => null);
      if (!res) { metaCache.delete(id); return null; }
      const meta: AttachmentMeta = {
        downloadUrl: res.downloadUrl,
        filename: res.filename,
        sizeBytes: res.sizeBytes ?? null,
        inlineKind: res.inlineKind ?? "none",
      };
      metaCache.set(id, { meta, exp: Date.parse(res.expiresAt) - 5_000 });
      return meta;
    },
    async inlineUrl(id) {
      const hit = blobCache.get(id);
      if (hit) return hit;
      try {
        const res = await fetch(assetUrl(`/attachments/${encodeURIComponent(id)}/inline`), {
          credentials: "include",
          headers: (() => { const t = bearerValue(token); return t ? { Authorization: `Bearer ${t}` } : undefined; })(),
        });
        if (!res.ok) return null; // 415 non-inline / 413 too large / 404 → the card renders without a viewer
        const url = URL.createObjectURL(await res.blob());
        blobCache.set(id, url);
        return url;
      } catch {
        return null;
      }
    },
  };
}

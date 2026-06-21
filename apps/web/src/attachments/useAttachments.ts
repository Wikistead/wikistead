import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../data/apiClient";
import { useSession } from "../session/SessionProvider";

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  createdAt: string;
}
interface Presigned { attachmentId: string; uploadUrl: string; expiresAt: string }

// The page's spaceId — needed to build the attachment endpoints. GET /pages/:id
// is FGA `view`-gated, so this also fails closed for pages the user can't see.
export function usePageMeta(pageId: string) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page", pageId],
    queryFn: () => apiFetch<{ id: string; spaceId: string; title: string }>(`/pages/${pageId}`, token),
  });
}

// list = FGA `view` on the page (server-enforced).
export function useAttachments(spaceId: string | undefined, pageId: string) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["attachments", pageId],
    queryFn: () => apiFetch<Attachment[]>(`/spaces/${spaceId}/pages/${pageId}/attachments`, token).then((r) => r ?? []),
    enabled: !!spaceId,
  });
}

// Upload = presign (FGA `edit`) -> direct PUT to storage -> confirm. The browser
// PUTs bytes straight to the presigned URL (server never proxies them). The
// content-type must match what was signed. Returns the confirmed attachment id +
// filename so callers (e.g. inserting an image into the page) can reference it.
export async function uploadAttachment(
  spaceId: string,
  pageId: string,
  token: string,
  file: File,
): Promise<{ id: string; filename: string }> {
  const ct = file.type || "application/octet-stream";
  const pres = await apiFetch<Presigned>(`/spaces/${spaceId}/pages/${pageId}/attachments/presign`, token, {
    method: "POST",
    body: JSON.stringify({ filename: file.name, contentType: ct }),
  });
  if (!pres) throw new Error("presign failed");
  // Read the file into memory first. Fetching a File straight from an <input> as
  // the body can abort mid-flight (the browser may detach the input's File backing
  // once the change handler returns); a detached ArrayBuffer is stable.
  const body = await file.arrayBuffer();
  // Direct cross-origin PUT to storage (server never proxies bytes). No auto-retry
  // (avoids pending-orphan growth; the user retries, backend GC reclaims orphans).
  const put = await fetch(pres.uploadUrl, { method: "PUT", body, headers: { "Content-Type": ct } });
  if (!put.ok) throw new Error(`upload failed (${put.status})`);
  // confirm reads size via HeadObject (short retry for S3 read-after-write) → confirmed.
  await apiFetch(`/attachments/${pres.attachmentId}/confirm`, token, { method: "POST" });
  return { id: pres.attachmentId, filename: file.name };
}

export function useUploadAttachment(spaceId: string | undefined, pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadAttachment(spaceId!, pageId, token, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attachments", pageId] }),
  });
}

export function useDeleteAttachment(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<null>(`/attachments/${id}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attachments", pageId] }),
  });
}

// Fetch a FRESH presigned GET URL on every click. NEVER cache/reuse it: the URL
// is an FGA-free bearer, so re-requesting routes each access back through the
// server's `view` check — permission revocation takes effect on the next click.
export async function fetchDownloadUrl(id: string, token: string): Promise<string | null> {
  const r = await apiFetch<{ downloadUrl: string; filename: string }>(`/attachments/${id}/download`, token);
  return r?.downloadUrl ?? null;
}

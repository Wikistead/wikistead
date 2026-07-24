// Export download. Fetches the export (auth via cookie or dev-token bearer — a
// plain link/navigation can't set the bearer) and triggers a client-side download
// from the blob, honoring the server's filename.
const API_URL = (import.meta as any).env?.VITE_API_URL ?? "/api";

// Shared download core (#309): fetch an export URL and, on success, save the blob honoring the
// server's filename. Returns the HTTP status (0 = network error) so callers can show a DEDICATED
// message for 413 (archive over the size budget) instead of a generic failure.
async function fetchToDownload(token: string, url: string, body?: unknown): Promise<number> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { return 0; }
  if (!res.ok) return res.status;
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
  const filename = m ? decodeURIComponent(m[1]!) : "export";
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
  return res.status;
}

// #85 / ADR-059: "html" hits the server render→sanitize path (a single page's published HTML);
// "md" (default) is the Markdown export (subtree + bundled images).
export async function downloadPageExport(token: string, pageId: string, format: "md" | "html" = "md"): Promise<boolean> {
  const path = format === "html" ? "export.html" : "export";
  const status = await fetchToDownload(token, `${API_URL}/pages/${encodeURIComponent(pageId)}/${path}`);
  return status >= 200 && status < 300;
}

// #309: space / tenant Markdown-ZIP exports (view-filtered server-side — every member may use them;
// they are NOT admin features). Both return the HTTP status for the 413 size-budget message.
export function downloadSpaceExport(token: string, spaceId: string): Promise<number> {
  return fetchToDownload(token, `${API_URL}/spaces/${encodeURIComponent(spaceId)}/export`);
}
export function downloadTenantExport(token: string): Promise<number> {
  return fetchToDownload(token, `${API_URL}/export`);
}

// #511 / ADR-185 (slice 4): export the CURRENT SELECTION from the space Pages tab. POST because the
// selection travels in the body; the response is the same ZIP stream (and the same 413 on the size budget).
// The server view-gates every selected page, so an id the caller cannot see is simply absent from the
// archive — the client never needs to pre-filter, and never learns whether such a page exists.
export function downloadSelectionExport(token: string, spaceId: string, pageIds: string[]): Promise<number> {
  return fetchToDownload(token, `${API_URL}/spaces/${encodeURIComponent(spaceId)}/pages/bulk-export`, { pageIds });
}

// #308 / ADR-132: import an export ZIP into a space (member-only; the server gates `edit`). The file is sent as
// base64 in a JSON body (no multipart dep, mirroring the icon/logo uploads). Returns { status, report } — the
// report is the server's summary (pages/attachments created, etc.) or null on any non-2xx.
export interface ImportReport {
  pagesCreated: number;
  emptyPagesCreated: number;
  attachmentsImported: number;
  attachmentsSkipped: { name: string; reason: string }[];
  deadCrossLinks: number;
  published: number;
  lossyTitles: boolean;
}
export async function importSpaceArchive(
  token: string,
  spaceId: string,
  file: File,
  opts: { publish?: boolean } = {},
): Promise<{ status: number; report: ImportReport | null }> {
  // File → base64 (chunked to avoid a call-stack blow-up on large archives).
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const zipBase64 = btoa(binary);
  let res: Response;
  try {
    res = await fetch(`${API_URL}/spaces/${encodeURIComponent(spaceId)}/import`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ zipBase64, publish: opts.publish === true }),
    });
  } catch { return { status: 0, report: null }; }
  const report = res.ok ? ((await res.json()) as ImportReport) : null;
  return { status: res.status, report };
}

// #207 part 2: print/PDF must render the WHOLE document statically — every macro rendered, no CM
// viewport virtualisation (only the on-screen slice is in the editor DOM), no reveal-on-cursor raw
// `:::` leaking. window.print() on the live editor surface can't do that; the #85 server HTML export
// (renderMarkdownToHtml → sanitise, all macros static, its own print stylesheet) is the faithful
// source. Fetch it and print it from an offscreen iframe so the app page never navigates away.
// Returns false if the page has no exportable HTML (unviewable / unpublished → 404) so the caller can
// fall back to the live-surface print.
export async function printPageHtml(token: string, pageId: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/pages/${encodeURIComponent(pageId)}/export.html`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return false;
  const html = await res.text();
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(iframe);
  const remove = () => { if (iframe.parentNode) iframe.remove(); };
  await new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
    iframe.srcdoc = html; // load the standalone export document (its own <style>/@page) into the frame
  });
  const win = iframe.contentWindow;
  if (!win) { remove(); return false; }
  // Remove the frame once the print dialog closes; keep a timeout fallback for browsers that never
  // fire afterprint (or where print() is synchronous and the dialog is modal).
  win.addEventListener("afterprint", () => setTimeout(remove, 0), { once: true });
  win.focus();
  win.print();
  setTimeout(remove, 60_000);
  return true;
}

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
// base64 in a JSON body (no multipart dep, mirroring the icon/logo uploads).
//
// #725 / ADR-236: the call answers TWO WAYS and the caller has to know which. Under the server's
// threshold the report comes back in the response; above it the server returns 202 with an import id
// and the report lands on the job row later. The previous shape here (`{ status, report }` with
// `report = await res.json()` whenever `res.ok`) read a 202 body as a report: `res.ok` is true for a
// 202, so the queued acknowledgement was cast to a report and the sidebar's toast interpolated
// `report.pagesCreated` — undefined — for exactly the large archives the 202 path exists for. A
// discriminated result makes that unrepresentable.
export interface ImportDegradation {
  node: string; // the node's title or dir, as the reader would recognise it
  // #725 ②: the SCREEN words this, from `code` and `params`. The server used to compose an
  // English sentence and this screen printed it through, so a Japanese workspace read its headings
  // and prose in Japanese and the one thing it was there to judge — what was lost — in English.
  // `what`/`detail` stay as the API's own English, and as the fallback when a code is unknown to
  // this build (an older server talking to a newer screen, or the reverse).
  code?: string;
  params?: Record<string, string | number>;
  what: string; // the shape that did not survive, in English
  detail?: string;
}
export interface ImportReport {
  // ADR-227's promise: every degradation NAMED. A screen that renders this as a count is the failure
  // the report exists to prevent (pinned in import-report-725.test.tsx).
  degraded: ImportDegradation[];
  pagesCreated: number;
  emptyPagesCreated: number;
  attachmentsImported: number;
  attachmentsSkipped: { name: string; reason: string }[];
  deadCrossLinks: number;
  published: number;
  lossyTitles: boolean;
}
export type ImportStart =
  | { kind: "report"; report: ImportReport }
  | { kind: "queued"; importId: string; nodesTotal: number }
  // #725 ①: a 409 names the import that is already running (#712), and that id is the
  // only thing that makes the refusal useful — without it the screen can say "busy" and nothing
  // else, while the progress it is telling the reader about is one link away. `running` is null
  // when that row settled between the refusal and the read, and the screen falls back to "reload".
  | { kind: "busy"; running: RunningImport | null }
  | { kind: "error"; status: number };

/** What a 409 says about the import already in flight (server: `spaces.ts`, #712). */
export interface RunningImport { id: string; status: string; nodesDone: number; nodesTotal: number }

// The server's body limit is 280 MiB of JSON, and base64 costs a third — so the archive the browser
// may send is three quarters of that, less the envelope. Checked before the upload because encoding
// and posting 200 MiB only to be told 413 is a slow way to learn the answer (ADR-236 §5). The server
// enforces its own limit regardless; this is kindness, not a gate.
export const IMPORT_MAX_ARCHIVE_BYTES = Math.floor((280 * 1024 * 1024 * 3) / 4) - 4096;

export async function importSpaceArchive(
  token: string,
  spaceId: string,
  file: File,
  opts: { publish?: boolean; parentPageId?: string | null } = {},
): Promise<ImportStart> {
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
      body: JSON.stringify({
        zipBase64,
        publish: opts.publish === true,
        ...(opts.parentPageId ? { parentPageId: opts.parentPageId } : {}),
      }),
    });
  } catch { return { kind: "error", status: 0 }; }
  if (res.status === 202) {
    const q = (await res.json()) as { importId: string; nodesTotal: number };
    return { kind: "queued", importId: q.importId, nodesTotal: q.nodesTotal };
  }
  if (res.status === 409) {
    // A malformed or absent body is not a reason to lose the refusal: `running: null` still means
    // "one is already going", and the screen has an honest answer for that.
    const b = await res.json().catch(() => null) as { running?: RunningImport | null } | null;
    return { kind: "busy", running: b?.running ?? null };
  }
  if (!res.ok) return { kind: "error", status: res.status };
  return { kind: "report", report: (await res.json()) as ImportReport };
}

// #712 / ADR-227 §7: the job row — progress while it runs, and the report once it is done. This is
// what makes a report outlive the connection that started it, which is why the screen keeps the
// import id in the URL rather than in component state (ADR-236 §3).
export interface ImportStatusRow {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  nodesTotal: number;
  nodesDone: number;
  report: ImportReport | null;
  error: string | null;
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

// Export download. Fetches the export (auth via cookie or dev-token bearer — a
// plain link/navigation can't set the bearer) and triggers a client-side download
// from the blob, honoring the server's filename.
const API_URL = (import.meta as any).env?.VITE_API_URL ?? "/api";

// #85 / ADR-059: "html" hits the server render→sanitize path (a single page's published HTML);
// "md" (default) is the Markdown export (subtree + bundled images).
export async function downloadPageExport(token: string, pageId: string, format: "md" | "html" = "md"): Promise<boolean> {
  const path = format === "html" ? "export.html" : "export";
  const res = await fetch(`${API_URL}/pages/${encodeURIComponent(pageId)}/${path}`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return false;
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
  const filename = m ? decodeURIComponent(m[1]!) : "export";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}

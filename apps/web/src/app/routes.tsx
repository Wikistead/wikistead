import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "./AppShell";
import { Editor } from "../editor/Editor";
import { Sidebar } from "../sidebar/Sidebar";
import { SearchBox } from "../search/SearchBox";
import { AttachmentsPanel } from "../attachments/AttachmentsPanel";
import { useSession } from "../session/SessionProvider";
import { fetchGuestToken, type GuestToken } from "../data/apiClient";

// Same-origin collab (ADR-016): a relative "/collab" is resolved against the
// current origin to an absolute ws(s):// URL (WebSocket needs an absolute URL),
// so it goes through the same proxy as /api. Absolute ws URLs are used as-is.
function resolveCollabUrl(): string {
  const v = (import.meta as any).env?.VITE_COLLAB_URL ?? "/collab";
  if (/^wss?:\/\//.test(v)) return v;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${v.startsWith("/") ? v : `/${v}`}`;
}
const COLLAB_URL = resolveCollabUrl();

// Member route: /p/:pageId — tenant comes from the session, docName is formed
// the same way the collab server expects ("t:<tenant>:p:<page>").
function PageRoute() {
  const { pageId } = useParams<{ pageId: string }>();
  const { token, tenantId, user } = useSession();
  const docName = `t:${tenantId}:p:${pageId}`;
  return (
    <AppShell sidebar={<Sidebar />} search={<SearchBox />}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <Editor key={docName} docName={docName} token={token} collabUrl={COLLAB_URL} user={user} />
        </div>
        {pageId && <AttachmentsPanel pageId={pageId} readOnly={false} />}
      </div>
    </AppShell>
  );
}

// Guest route: /share/:linkId. The URL carries only the unguessable link id; we
// exchange it for a short-lived guest token at the public landing endpoint, then
// open the editor (read-only for view-capability links). No member chrome.
function ShareRoute() {
  const { linkId } = useParams<{ linkId: string }>();
  const [state, setState] = useState<{ status: "loading" | "denied" | "ok"; minted?: GuestToken }>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    if (!linkId) {
      setState({ status: "denied" });
      return;
    }
    fetchGuestToken(linkId).then((minted) => {
      if (cancelled) return;
      setState(minted ? { status: "ok", minted } : { status: "denied" });
    });
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  if (state.status === "loading") {
    return <AppShell><div style={{ padding: 16 }}>Opening shared page…</div></AppShell>;
  }
  if (state.status === "denied" || !state.minted) {
    return <AppShell><div style={{ padding: 16 }}>This share link is invalid, expired, or revoked.</div></AppShell>;
  }
  const { token, docName, readOnly } = state.minted;
  // Anonymous guest identity (never an OIDC account / seat — the project design notes).
  const guest = { name: `guest-${Math.floor(Math.random() * 1000)}`, color: "#7d8590" };
  return (
    <AppShell>
      <Editor key={docName} docName={docName} token={token} collabUrl={COLLAB_URL} user={guest} readOnly={readOnly} />
    </AppShell>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/p/:pageId" element={<PageRoute />} />
      <Route path="/share/:linkId" element={<ShareRoute />} />
      {/* Dev default: the seeded demo page. Real landing/space routing is a
          next-stage screen. */}
      <Route path="*" element={<Navigate to="/p/demo" replace />} />
    </Routes>
  );
}

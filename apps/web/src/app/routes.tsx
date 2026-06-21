import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AppShell } from "./AppShell";
import { Editor, type AnchorGetter } from "../editor/Editor";
import { CommentsPanel } from "../comments/CommentsPanel";
import { useComments } from "../data/comments";
import { Sidebar } from "../sidebar/Sidebar";
import { SearchBox } from "../search/SearchBox";
import { AttachmentsPanel } from "../attachments/AttachmentsPanel";
import { useSession } from "../session/SessionProvider";
import { fetchGuestToken, type GuestToken } from "../data/apiClient";
import { usePage } from "../data/queries";
import { uploadAttachment } from "../attachments/useAttachments";
import { MembersPage } from "../settings/MembersPage";

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

// Shown when there is no member session (real mode). Kicks off the OIDC flow as a
// top-level navigation to /auth/login (preserving where the user wanted to go).
function LoginScreen() {
  const returnTo = window.location.pathname + window.location.search;
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 420 }}>
        <h2 style={{ marginTop: 0 }}>Sign in to wikistead</h2>
        <p style={{ color: "var(--fg-dim)" }}>Continue with your organization's identity provider.</p>
        <button
          type="button"
          onClick={() => { window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`; }}
        >
          Sign in
        </button>
      </div>
    </AppShell>
  );
}

// Member route: /p/:pageId — tenant comes from the session, docName is formed
// the same way the collab server expects ("t:<tenant>:p:<page>").
function PageRoute() {
  const { pageId } = useParams<{ pageId: string }>();
  const { status, collabToken, tenantId, user, logout, token } = useSession();
  // Capability gates the Edit control (UI only — collab server is the fortress).
  // Defaults to view until resolved, so a page is never editable speculatively.
  // The dev-token bypass is god-mode (matches collab's dev-token = readOnly:false),
  // so it defaults to edit — and works for not-yet-persisted pages getPage 404s on.
  const devMode = token === "dev-token";
  const { data: page } = usePage(pageId ?? "");
  const capability = page?.capability ?? (devMode ? "edit" : "view");

  // Upload a picked image to this page's space, returning the ref to insert. Bound
  // to the resolved spaceId; null (no image button) until the page meta loads.
  const spaceId = page?.spaceId;
  const onUploadImage = useCallback(
    async (file: File) => {
      if (!spaceId || !pageId) return null;
      const { id, filename } = await uploadAttachment(spaceId, pageId, token, file);
      return { ref: `wks-attachment:${id}`, alt: filename };
    },
    [spaceId, pageId, token],
  );

  // Inline-comment integration: the panel and the editor share one comments query.
  // Inline threads (with anchors) become editor highlights; the panel builds inline
  // threads from the editor's current selection via this anchor getter.
  const anchorGetterRef = useRef<AnchorGetter | null>(null);
  const { data: threads } = useComments(pageId ?? "");
  const inlineComments = (threads ?? [])
    .filter((t) => t.kind === "inline" && t.anchorStart && t.anchorEnd)
    .map((t) => ({ threadId: t.id, anchorStart: t.anchorStart!, anchorEnd: t.anchorEnd!, resolved: t.status === "resolved" }));

  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>Loading…</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  const docName = `t:${tenantId}:p:${pageId}`;
  return (
    <AppShell sidebar={<Sidebar />} search={<SearchBox />} onLogout={logout}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <Editor key={docName} docName={docName} token={collabToken} collabUrl={COLLAB_URL} user={user} capability={capability} apiToken={token} onUploadImage={onUploadImage} inlineComments={inlineComments} anchorGetterRef={anchorGetterRef} />
          </div>
          {pageId && <AttachmentsPanel pageId={pageId} readOnly={capability !== "edit"} />}
        </div>
        {pageId && <CommentsPanel pageId={pageId} canComment={capability === "edit"} anchorGetterRef={anchorGetterRef} />}
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
  const { token, docName, capability } = state.minted;
  // Anonymous guest identity (never an OIDC account / seat — the project design notes).
  const guest = { name: `guest-${Math.floor(Math.random() * 1000)}`, color: "#7d8590" };
  return (
    <AppShell>
      <Editor key={docName} docName={docName} token={token} collabUrl={COLLAB_URL} user={guest} capability={capability} />
    </AppShell>
  );
}

// Cloud signup landing (platform origin). Public — no session yet. Starts the
// platform-IdP flow as a top-level navigation to /signup/login (proxied to the API).
function JoinRoute() {
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>Create your wikistead workspace</h2>
        <p style={{ color: "var(--fg-dim)" }}>Sign up with your identity provider to get started.</p>
        <button type="button" onClick={() => { window.location.href = "/signup/login"; }}>Sign up</button>
      </div>
    </AppShell>
  );
}

// After platform-IdP signup: choose a workspace name → POST /signup/tenants (uses
// the signup session cookie) → redirect to the new tenant subdomain, where the
// member logs in via platform-IdP SSO (a fresh host-only member session there).
function WorkspaceRoute() {
  const [slug, setSlug] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    const res = await fetch("/signup/tenants", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    if (res.ok) {
      const { tenantUrl } = (await res.json()) as { tenantUrl: string };
      window.location.href = tenantUrl;
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setErr(body.error ?? "Could not create workspace");
    setBusy(false);
  };
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>Name your workspace</h2>
        <p style={{ color: "var(--fg-dim)" }}>This becomes your subdomain. Lowercase letters, numbers and hyphens.</p>
        <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-team" aria-label="Workspace name" />
        {err && <p style={{ color: "crimson" }}>{err}</p>}
        <button type="button" disabled={busy || !slug} onClick={submit}>Create workspace</button>
      </div>
    </AppShell>
  );
}

// Invite acceptance landing: the link carries ?token. Accepting starts the OIDC
// login with the token attached (?invite=) — the callback accepts the invite and
// seats the user (the new membership grant). The token is opaque to the SPA.
function InviteRoute() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const accept = () => {
    window.location.href = `/auth/login?invite=${encodeURIComponent(token)}&returnTo=${encodeURIComponent("/p/demo")}`;
  };
  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 440 }}>
        <h2 style={{ marginTop: 0 }}>You've been invited</h2>
        <p style={{ color: "var(--fg-dim)" }}>Sign in to accept your invitation and join the workspace.</p>
        <button type="button" disabled={!token} onClick={accept}>Accept invite</button>
      </div>
    </AppShell>
  );
}

// Admin Console (members). Requires a member session; the page itself enforces
// admin-only via the API (non-admins see an "admin only" notice).
function SettingsMembersRoute() {
  const { status, logout } = useSession();
  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>Loading…</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  return <AppShell onLogout={logout}><MembersPage /></AppShell>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/p/:pageId" element={<PageRoute />} />
      <Route path="/share/:linkId" element={<ShareRoute />} />
      <Route path="/invite" element={<InviteRoute />} />
      <Route path="/settings/members" element={<SettingsMembersRoute />} />
      <Route path="/join" element={<JoinRoute />} />
      <Route path="/join/workspace" element={<WorkspaceRoute />} />
      {/* Dev default: the seeded demo page. Real landing/space routing is a
          next-stage screen. */}
      <Route path="*" element={<Navigate to="/p/demo" replace />} />
    </Routes>
  );
}

import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppShell } from "../app/AppShell";
import { LoginScreen } from "../app/LoginScreen";
import { useSession } from "../session/SessionProvider";
import { MembersPage } from "./MembersPage";
import { AdminSpacesTab } from "./AdminSpacesTab";
import { TenantBrandingTab } from "./TenantBrandingTab";
import { AdminAuthTab } from "./AdminAuthTab";
import { AdminApiTab } from "./AdminApiTab";
import { AdminWebhooksTab } from "./AdminWebhooksTab";
import { AdminAuditTab } from "./AdminAuditTab";
import { AdminRolesTab } from "./AdminRolesTab";
import { AdminAnalyticsTab } from "./AdminAnalyticsTab";
import { AdminScimTab } from "./AdminScimTab";
import { AdminDomainsTab } from "./AdminDomainsTab";
import { AdminEmbedsTab } from "./AdminEmbedsTab";
import { AdminPublicTab } from "./AdminPublicTab";
import { AdminBillingTab } from "./AdminBillingTab";
import { AdminOrphanDraftsTab } from "./AdminOrphanDraftsTab";
import { AdminModerationTab } from "./AdminModerationTab"; // #491
import { SettingsShell, SettingsDenied, type SettingsTab } from "./SettingsShell";
import { useAdminSurfaces } from "../data/queries";

// Tenant admin console (Phase 5a). The admin-screen leak rule is 403 (not 404): a tenant having an
// admin area is not a secret, somebody without the power simply can't enter (every action re-checks
// server-side regardless — this is chrome).
//
// #604-B: the console is no longer tier-gated as a whole. The SERVER answers which surfaces
// are open to the caller (GET /admin/surfaces, one registry: surface → tenant relation), and this
// screen renders exactly that answer — the tabs, the landing redirect and the direct-link verdict
// all read the same list. An admin answers true to every relation, so nothing changes for them; a
// verb holder sees only the tab their verb opens, and never gets shown a tab that would 403.
// Adding a verb server-side needs no edit here.
function useAdminTabs(): SettingsTab[] {
  const { t } = useTranslation();
  return [
    { key: "members", label: t("adminNav.members"), to: "/admin/members" },
    { key: "spaces", label: t("adminNav.spaces"), to: "/admin/spaces" },
    { key: "branding", label: t("adminNav.branding"), to: "/admin/branding" },
    { key: "auth", label: t("adminNav.auth"), to: "/admin/auth" },
    { key: "api", label: t("adminNav.api"), to: "/admin/api" },
    { key: "webhooks", label: t("adminNav.webhooks"), to: "/admin/webhooks" },
    { key: "audit", label: t("adminNav.audit"), to: "/admin/audit" },
    { key: "analytics", label: t("adminNav.analytics"), to: "/admin/analytics" }, // #520 / ADR-189: tenant roll-up
    { key: "scim", label: t("adminNav.scim"), to: "/admin/scim" },
    { key: "domains", label: t("adminNav.domains"), to: "/admin/domains" }, // #721 / ADR-230 // #723 / ADR-232: mint the IdP's token
    { key: "roles", label: t("adminNav.roles"), to: "/admin/roles" },
    { key: "embeds", label: t("adminNav.embeds"), to: "/admin/embeds" },
    { key: "public", label: t("adminNav.public"), to: "/admin/public" },
    { key: "moderation", label: t("adminNav.moderation"), to: "/admin/moderation" }, // #491
    { key: "billing", label: t("adminNav.billing"), to: "/admin/billing" },
    { key: "orphans", label: t("adminNav.orphans"), to: "/admin/orphan-drafts" },
  ];
}

function AdminLayout() {
  const { t } = useTranslation();
  const { status, logout } = useSession();
  const tabs = useAdminTabs();
  const surfaces = useAdminSurfaces();

  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  // The answer is still loading: show the shell's spinner rather than flashing "no access" at
  // somebody who has it (the console is behind a lazy chunk already — one more tick is invisible).
  if (surfaces.isLoading) return <AppShell onLogout={logout}><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  const open = surfaces.data ?? [];
  // Nothing is open to you — the same refusal as before, now for the same reason the routes give.
  if (open.length === 0) return <AppShell onLogout={logout}><SettingsDenied kind="forbidden" /></AppShell>;

  return (
    <AppShell onLogout={logout}>
      <SettingsShell title={t("adminNav.title")} tabs={tabs.filter((tab) => open.includes(tab.key))}>
        <Outlet />
      </SettingsShell>
    </AppShell>
  );
}

// One surface, one verdict: render the tab when the server listed it, refuse otherwise. This is what
// answers a DIRECT link — a pasted /admin/roles from somebody who only manages connections lands on
// the same refusal the route would give, instead of an empty screen full of 403s.
function Surface({ name, children }: { name: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  const surfaces = useAdminSurfaces();
  if (surfaces.isLoading) return <div style={{ padding: 16 }}>{t("common.loading")}</div>;
  if (!(surfaces.data ?? []).includes(name)) return <SettingsDenied kind="forbidden" />;
  return <>{children}</>;
}

// Where /admin lands: the FIRST surface open to this caller, in the console's own tab order. It used
// to be a hard-coded "members", which for a connection manager is the one tab they cannot enter.
function AdminIndexRedirect() {
  const tabs = useAdminTabs();
  const surfaces = useAdminSurfaces();
  const { t } = useTranslation();
  if (surfaces.isLoading) return <div style={{ padding: 16 }}>{t("common.loading")}</div>;
  const open = surfaces.data ?? [];
  const first = tabs.find((tab) => open.includes(tab.key));
  if (!first) return <SettingsDenied kind="forbidden" />;
  return <Navigate to={first.to.replace(/^\/admin\//, "")} replace />;
}

// #489: the admin console is code-split. AdminRoot renders the subtree as its OWN <Routes> (paths
// RELATIVE to the /admin/* mount point in routes.tsx), so it can be lazy-imported behind a Suspense
// boundary and dropped from the eager main bundle. The route STRUCTURE is unchanged — same paths, same
// components, same AdminLayout wrapper — only where the code loads from moves.
export function AdminRoot() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<AdminIndexRedirect />} />
        <Route path="members" element={<Surface name="members"><MembersPage /></Surface>} />
        <Route path="spaces" element={<Surface name="spaces"><AdminSpacesTab /></Surface>} />
        <Route path="branding" element={<Surface name="branding"><TenantBrandingTab /></Surface>} />
        <Route path="auth" element={<Surface name="auth"><AdminAuthTab /></Surface>} />
        <Route path="api" element={<Surface name="api"><AdminApiTab /></Surface>} />
        <Route path="webhooks" element={<Surface name="webhooks"><AdminWebhooksTab /></Surface>} />
        <Route path="audit" element={<Surface name="audit"><AdminAuditTab /></Surface>} />
        <Route path="analytics" element={<Surface name="analytics"><AdminAnalyticsTab /></Surface>} />
        <Route path="scim" element={<Surface name="scim"><AdminScimTab /></Surface>} />
        <Route path="domains" element={<Surface name="domains"><AdminDomainsTab /></Surface>} />
        <Route path="roles" element={<Surface name="roles"><AdminRolesTab /></Surface>} />
        <Route path="embeds" element={<Surface name="embeds"><AdminEmbedsTab /></Surface>} />
        <Route path="public" element={<Surface name="public"><AdminPublicTab /></Surface>} />
        <Route path="moderation" element={<Surface name="moderation"><AdminModerationTab /></Surface>} />
        <Route path="billing" element={<Surface name="billing"><AdminBillingTab /></Surface>} />
        <Route path="orphan-drafts" element={<Surface name="orphans"><AdminOrphanDraftsTab /></Surface>} />
      </Route>
    </Routes>
  );
}

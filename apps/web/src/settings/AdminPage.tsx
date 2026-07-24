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
import { AdminEmbedsTab } from "./AdminEmbedsTab";
import { AdminPublicTab } from "./AdminPublicTab";
import { AdminBillingTab } from "./AdminBillingTab";
import { AdminOrphanDraftsTab } from "./AdminOrphanDraftsTab";
import { AdminModerationTab } from "./AdminModerationTab"; // #491
import { SettingsShell, SettingsDenied, type SettingsTab } from "./SettingsShell";

// Tenant admin console (Phase 5a). Gate: tenant#admin. All tabs now live (Members,
// Spaces, Branding, Auth, API, Billing). The admin-screen leak rule is 403 (not
// 404): a tenant having an admin area is not a secret, the non-admin simply can't
// enter (the server re-checks tenant#admin on every admin action).
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
  const { status, isAdmin, logout } = useSession();
  const tabs = useAdminTabs();

  if (status === "loading") return <AppShell><div style={{ padding: 16 }}>{t("common.loading")}</div></AppShell>;
  if (status === "anon") return <LoginScreen />;
  // isAdmin gates the UI only; every admin action below re-checks tenant#admin
  // server-side (the screen's data calls hit admin-only endpoints).
  if (!isAdmin) return <AppShell onLogout={logout}><SettingsDenied kind="forbidden" /></AppShell>;

  return (
    <AppShell onLogout={logout}>
      <SettingsShell title={t("adminNav.title")} tabs={tabs}>
        <Outlet />
      </SettingsShell>
    </AppShell>
  );
}

// #489: the admin console is code-split. AdminRoot renders the subtree as its OWN <Routes> (paths
// RELATIVE to the /admin/* mount point in routes.tsx), so it can be lazy-imported behind a Suspense
// boundary and dropped from the eager main bundle. The route STRUCTURE is unchanged — same paths, same
// components, same AdminLayout wrapper — only where the code loads from moves.
export function AdminRoot() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<Navigate to="members" replace />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="spaces" element={<AdminSpacesTab />} />
        <Route path="branding" element={<TenantBrandingTab />} />
        <Route path="auth" element={<AdminAuthTab />} />
        <Route path="api" element={<AdminApiTab />} />
        <Route path="webhooks" element={<AdminWebhooksTab />} />
        <Route path="audit" element={<AdminAuditTab />} />
        <Route path="analytics" element={<AdminAnalyticsTab />} />
        <Route path="roles" element={<AdminRolesTab />} />
        <Route path="embeds" element={<AdminEmbedsTab />} />
        <Route path="public" element={<AdminPublicTab />} />
        <Route path="moderation" element={<AdminModerationTab />} />
        <Route path="billing" element={<AdminBillingTab />} />
        <Route path="orphan-drafts" element={<AdminOrphanDraftsTab />} />
      </Route>
    </Routes>
  );
}

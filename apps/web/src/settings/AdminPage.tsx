import { Navigate, Outlet, Route } from "react-router-dom";
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
import { AdminEmbedsTab } from "./AdminEmbedsTab";
import { AdminPublicTab } from "./AdminPublicTab";
import { AdminBillingTab } from "./AdminBillingTab";
import { AdminOrphanDraftsTab } from "./AdminOrphanDraftsTab";
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
    { key: "embeds", label: t("adminNav.embeds"), to: "/admin/embeds" },
    { key: "public", label: t("adminNav.public"), to: "/admin/public" },
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

// Returned as inline <Route> elements so the parent <Routes> can parse them.
export function AdminRoutes() {
  return (
    <Route path="/admin" element={<AdminLayout />}>
      <Route index element={<Navigate to="members" replace />} />
      <Route path="members" element={<MembersPage />} />
      <Route path="spaces" element={<AdminSpacesTab />} />
      <Route path="branding" element={<TenantBrandingTab />} />
      <Route path="auth" element={<AdminAuthTab />} />
      <Route path="api" element={<AdminApiTab />} />
      <Route path="webhooks" element={<AdminWebhooksTab />} />
      <Route path="audit" element={<AdminAuditTab />} />
      <Route path="embeds" element={<AdminEmbedsTab />} />
      <Route path="public" element={<AdminPublicTab />} />
      <Route path="billing" element={<AdminBillingTab />} />
      <Route path="orphan-drafts" element={<AdminOrphanDraftsTab />} />
    </Route>
  );
}

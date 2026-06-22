import { Navigate, Outlet, Route } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppShell } from "../app/AppShell";
import { LoginScreen } from "../app/LoginScreen";
import { useSession } from "../session/SessionProvider";
import { MembersPage } from "./MembersPage";
import { AdminSpacesTab } from "./AdminSpacesTab";
import { TenantBrandingTab } from "./TenantBrandingTab";
import { SettingsShell, SettingsDenied, SettingsPlaceholder, type SettingsTab } from "./SettingsShell";

// Tenant admin console (Phase 5a). Gate: tenant#admin. Members ships now; the
// other tabs are placeholders whose features land in later subphases (the IA — the
// vertical tab rail — stands first). The admin-screen leak rule is 403 (not 404):
// a tenant having an admin area is not a secret, the non-admin simply can't enter.
function useAdminTabs(): SettingsTab[] {
  const { t } = useTranslation();
  return [
    { key: "members", label: t("adminNav.members"), to: "/admin/members" },
    { key: "spaces", label: t("adminNav.spaces"), to: "/admin/spaces" },
    { key: "branding", label: t("adminNav.branding"), to: "/admin/branding" },
    { key: "auth", label: t("adminNav.auth"), to: "/admin/auth", soon: true },
    { key: "api", label: t("adminNav.api"), to: "/admin/api", soon: true },
    { key: "billing", label: t("adminNav.billing"), to: "/admin/billing", soon: true },
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

function AdminPlaceholder({ tabKey }: { tabKey: string }) {
  const { t } = useTranslation();
  return <SettingsPlaceholder label={t(`adminNav.${tabKey}`)} />;
}

// Returned as inline <Route> elements so the parent <Routes> can parse them.
export function AdminRoutes() {
  return (
    <Route path="/admin" element={<AdminLayout />}>
      <Route index element={<Navigate to="members" replace />} />
      <Route path="members" element={<MembersPage />} />
      <Route path="spaces" element={<AdminSpacesTab />} />
      <Route path="branding" element={<TenantBrandingTab />} />
      <Route path="auth" element={<AdminPlaceholder tabKey="auth" />} />
      <Route path="api" element={<AdminPlaceholder tabKey="api" />} />
      <Route path="billing" element={<AdminPlaceholder tabKey="billing" />} />
    </Route>
  );
}

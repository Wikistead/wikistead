import { useState, type ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageToggle } from "./LanguageToggle";
import { UserMenu } from "./UserMenu";
import { BrandLockup } from "./BrandLockup";
import { useBranding } from "../data/queries";
import styles from "./AppShell.module.css";

// App skeleton: header / sidebar slot / main content. `sidebar` holds the page
// tree and `search` the search box — both member-only; guest (share) routes pass
// neither (no cross-tenant search/navigation for anonymous link visitors).
// `onLogout`, when given, renders a logout control (member chrome only). The
// sidebar can be collapsed via the header toggle; the choice persists.
export function AppShell({
  children,
  sidebar,
  search,
  onLogout,
}: {
  children: ReactNode;
  sidebar?: ReactNode;
  search?: ReactNode;
  onLogout?: () => void;
}) {
  const { t } = useTranslation();
  const branding = useBranding();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("wks.sidebarCollapsed") === "1"; } catch { return false; }
  });
  const toggle = () => setCollapsed((v) => {
    const n = !v;
    try { localStorage.setItem("wks.sidebarCollapsed", n ? "1" : "0"); } catch { /* no storage */ }
    return n;
  });

  return (
    <div className={styles.shell} data-collapsed={sidebar && collapsed ? "true" : "false"}>
      <header className={styles.header}>
        {sidebar ? (
          <button type="button" className={styles.collapseBtn} aria-label={t("nav.toggleSidebar")} aria-pressed={!collapsed} data-testid="sidebar-toggle" onClick={toggle}>
            <PanelLeft size={16} />
          </button>
        ) : (
          <PanelLeft size={16} aria-hidden />
        )}
        {/* Brand: tenant logo ▷ tenant display name ▷ the Wikistead lockup. */}
        {branding.data?.logoUrl ? (
          <img className={styles.logo} src={branding.data.logoUrl} alt={branding.data.displayName || "Wikistead"} data-testid="brand-logo" />
        ) : branding.data?.displayName ? (
          <span className={styles.wordmark} data-testid="brand">{branding.data.displayName}</span>
        ) : (
          <BrandLockup />
        )}
        <div className={styles.spacer} />
        {search && <div className={styles.search}>{search}</div>}
        <LanguageToggle />
        <ThemeToggle />
        {onLogout && <UserMenu onLogout={onLogout} />}
      </header>
      <aside className={styles.sidebar}>{sidebar}</aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}

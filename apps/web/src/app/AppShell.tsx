import { useState, type ReactNode } from "react";
import { LogOut, PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "./ThemeToggle";
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
        <span className={styles.brand}>wikistead</span>
        <div className={styles.spacer} />
        {search && <div className={styles.search}>{search}</div>}
        <ThemeToggle />
        {onLogout && (
          <button type="button" className={styles.logout} aria-label={t("nav.signOut")} title={t("nav.signOut")} onClick={onLogout}>
            <LogOut size={15} />
          </button>
        )}
      </header>
      <aside className={styles.sidebar}>{sidebar}</aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}

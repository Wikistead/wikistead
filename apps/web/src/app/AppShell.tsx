import type { ReactNode } from "react";
import { LogOut, PanelLeft } from "lucide-react";
import styles from "./AppShell.module.css";

// App skeleton: header / sidebar slot / main content. `sidebar` holds the page
// tree and `search` the search box — both member-only; guest (share) routes pass
// neither (no cross-tenant search/navigation for anonymous link visitors).
// `onLogout`, when given, renders a logout control (member chrome only).
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
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <PanelLeft size={16} aria-hidden />
        <span className={styles.brand}>wikistead</span>
        {search && <div className={styles.search}>{search}</div>}
        {onLogout && (
          <button type="button" className={styles.logout} aria-label="Sign out" title="Sign out" onClick={onLogout}>
            <LogOut size={15} />
          </button>
        )}
      </header>
      <aside className={styles.sidebar}>{sidebar}</aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}

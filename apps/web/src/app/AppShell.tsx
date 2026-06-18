import type { ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import styles from "./AppShell.module.css";

// App skeleton: header / sidebar slot / main content. The sidebar and header
// controls are intentionally empty slots — the page tree, search, share and
// account UI land here in the next (screens) stage.
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <PanelLeft size={16} aria-hidden />
        <span className={styles.brand}>wikistead</span>
      </header>
      <aside className={styles.sidebar}>
        <div className={styles.slot}>Sidebar slot — next stage</div>
      </aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}

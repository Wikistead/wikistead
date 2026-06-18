import type { ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import styles from "./AppShell.module.css";

// App skeleton: header / sidebar slot / main content. The `sidebar` slot holds
// the page tree for member routes; guest (share) routes pass nothing.
export function AppShell({ children, sidebar }: { children: ReactNode; sidebar?: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <PanelLeft size={16} aria-hidden />
        <span className={styles.brand}>wikistead</span>
      </header>
      <aside className={styles.sidebar}>{sidebar}</aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}

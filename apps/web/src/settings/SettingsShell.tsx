import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import styles from "./SettingsShell.module.css";

export interface SettingsTab {
  key: string;
  label: string;
  to: string;
  // A tab whose feature ships in a later subphase: shown but routed to a "coming
  // soon" placeholder, so the IA (vertical tab rail) stands before the contents do.
  soon?: boolean;
}

// Two-tier settings layout (Notion/Confluence style): a left vertical tab rail +
// a content pane. Used by both the tenant admin console and the per-space settings
// screen — the tabs differ, the chrome does not. A "back to app" link returns to
// the editing surface (the catch-all route redirects "/" → the default page).
export function SettingsShell({
  title,
  tabs,
  children,
}: {
  title: string;
  tabs: SettingsTab[];
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.wrap}>
      <nav className={styles.rail} aria-label={title}>
        <NavLink to="/" className={styles.back} data-testid="settings-back">
          <ArrowLeft size={14} /> {t("settings.back")}
        </NavLink>
        <div className={styles.railTitle}>{title}</div>
        {tabs.map((tab) => (
          <NavLink
            key={tab.key}
            to={tab.to}
            className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ""}`}
            data-testid={`settings-tab-${tab.key}`}
          >
            <span>{tab.label}</span>
            {tab.soon && <span className={styles.soon}>{t("settings.soon")}</span>}
          </NavLink>
        ))}
      </nav>
      <section className={styles.content}>{children}</section>
    </div>
  );
}

// Shown when a screen is reached without authority. The wording differs by reason
// so the UI matches the leak rule (404 hides existence; 403 admits it but denies).
export function SettingsDenied({ kind }: { kind: "forbidden" | "notFound" }) {
  const { t } = useTranslation();
  return (
    <div className={styles.denied} data-testid={kind === "forbidden" ? "settings-forbidden" : "settings-notfound"}>
      <h2>{t(kind === "forbidden" ? "settings.forbiddenTitle" : "settings.notFoundTitle")}</h2>
      <p>{t(kind === "forbidden" ? "settings.forbiddenBody" : "settings.notFoundBody")}</p>
      <NavLink to="/" className={styles.back}><ArrowLeft size={14} /> {t("settings.back")}</NavLink>
    </div>
  );
}

// A tab whose feature lands in a later subphase. Keeps the IA navigable now.
export function SettingsPlaceholder({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <div className={styles.placeholder} data-testid="settings-placeholder">
      <h2>{label}</h2>
      <p>{t("settings.placeholder")}</p>
    </div>
  );
}

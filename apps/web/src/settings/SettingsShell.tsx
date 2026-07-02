import type { ComponentType, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { cn } from "../lib/utils";

export interface SettingsTab {
  key: string;
  label: string;
  to: string;
  // #194: a Lucide icon for the rail (aligns with the app-wide Lucide set — ADR-052). Optional so
  // existing callers without icons still render (label-only).
  icon?: ComponentType<{ size?: number | string; className?: string }>;
  // A tab whose feature ships in a later subphase: shown but routed to a "coming
  // soon" placeholder, so the IA (vertical tab rail) stands before the contents do.
  soon?: boolean;
  // Exact-match the active state. Needed for an INDEX tab whose path is a prefix of its
  // siblings (e.g. /settings/account vs /settings/account/editor) — without it the parent
  // tab stays highlighted on every child route.
  end?: boolean;
}

const backLink = "mb-2 inline-flex w-fit items-center gap-1.5 rounded px-2 py-1 text-xs text-fg-dim no-underline hover:bg-panel-2 hover:text-foreground";

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
    // Center the whole settings block (rail + content) with a max width, so it doesn't
    // hug the left edge / shift by viewport width and stays consistent across every
    // settings screen (Account / Admin / Space) — Notion/Confluence-style centered panel.
    <div className="mx-auto grid h-full min-h-0 w-full max-w-[1100px] grid-cols-[220px_1fr]">
      <nav className="box-border flex flex-col gap-0.5 overflow-y-auto border-r border-border bg-panel p-3" aria-label={title}>
        <NavLink to="/" className={backLink} data-testid="settings-back">
          <ArrowLeft size={14} /> {t("settings.back")}
        </NavLink>
        <div className="mb-0.5 px-2 py-1 text-[11px] uppercase tracking-[0.04em] text-fg-dim">{title}</div>
        {tabs.map((tab) => (
          <NavLink
            key={tab.key}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => cn(
              "flex items-center gap-2 rounded-md px-2 py-[7px] text-[length:var(--text-ui)] text-foreground no-underline hover:bg-panel-2",
              isActive && "bg-panel-2 font-semibold shadow-[inset_2px_0_0_var(--accent)]",
            )}
            data-testid={`settings-tab-${tab.key}`}
          >
            {tab.icon && <tab.icon size={16} className="flex-none text-fg-dim" />}
            <span className="flex-1">{tab.label}</span>
            {tab.soon && <span className="rounded-full border border-border px-1.5 text-[10px] leading-4 text-fg-dim">{t("settings.soon")}</span>}
          </NavLink>
        ))}
      </nav>
      <section className="min-h-0 min-w-0 overflow-y-auto">{children}</section>
    </div>
  );
}

// Shown when a screen is reached without authority. The wording differs by reason
// so the UI matches the leak rule (404 hides existence; 403 admits it but denies).
export function SettingsDenied({ kind }: { kind: "forbidden" | "notFound" }) {
  const { t } = useTranslation();
  return (
    <div className="max-w-[560px] px-6 py-8 text-fg-dim" data-testid={kind === "forbidden" ? "settings-forbidden" : "settings-notfound"}>
      <h2 className="mt-0 text-foreground">{t(kind === "forbidden" ? "settings.forbiddenTitle" : "settings.notFoundTitle")}</h2>
      <p>{t(kind === "forbidden" ? "settings.forbiddenBody" : "settings.notFoundBody")}</p>
      <NavLink to="/" className={backLink}><ArrowLeft size={14} /> {t("settings.back")}</NavLink>
    </div>
  );
}

// A tab whose feature lands in a later subphase. Keeps the IA navigable now.
export function SettingsPlaceholder({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <div className="max-w-[560px] px-6 py-8 text-fg-dim" data-testid="settings-placeholder">
      <h2 className="mt-0 text-foreground">{label}</h2>
      <p>{t("settings.placeholder")}</p>
    </div>
  );
}

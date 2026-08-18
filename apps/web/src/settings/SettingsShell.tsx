import type { ComponentType, ReactNode } from "react";
import { SELECTED_ROW } from "../ui/selected-row"; // #632: one answer to "which row am I on"
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

/**
 * #735: the settings content column, in THREE widths and no others.
 *
 * The ruling was explicit that the six values in the tree (560 / 640 / 720 / 860 / 920 / none) must not
 * simply be renamed — the number of steps is decided first, then the surfaces are assigned to them. So
 * they are decided here, by what the content IS rather than by what each screen happened to be:
 *
 *   form  a column of labelled fields. Line length is the constraint; wider is worse to read.
 *   list  rows with an action or two on the right (API keys, webhooks, spaces, SCIM, domains).
 *   wide  a real table with several columns (roles, the audit log, a space's pages).
 *
 * 640 folds up into `list` and 860 folds up into `wide`: every fold WIDENS. Narrowing a table to reach
 * a tier would take away room the table was using, which is a visible regression traded for tidiness.
 *
 * The PADDING is not here — it is the shell's, unconditionally (see the section below). This decides
 * how wide the column is, and nothing about whether a tab that forgets it looks broken.
 *
 * A tab spells its choice as `data-settings-pane="<step>" className={SETTINGS_WIDTHS.<step>}` on its
 * root. The attribute is what the discovery walk reads, and the walk cross-checks it against the
 * width the browser actually computed — so a root that names one step and wears another is red rather
 * than merely odd. (A `<SettingsPane>` wrapper was written first and thrown away: every root here
 * already carries a testid, a semantic element and its own classes, so the component would have added
 * a div around each one to save a pair of attributes.)
 */
export const SETTINGS_WIDTHS = {
  form: "max-w-[560px]",
  list: "max-w-[720px]",
  wide: "max-w-[920px]",
} as const;
export type SettingsWidth = keyof typeof SETTINGS_WIDTHS;

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
    // #194 (revised): the rail sits FLUSH to the left edge and the content pane fills the rest of the
    // width — Linear-style. The previous `mx-auto max-w-[1100px]` centered the whole rail+content
    // block, leaving an awkward gap to the LEFT of the rail and between the rail and the content on
    // wide screens. Readability is kept by the content column's own max-width (SettingsPage), not by
    // centering the whole screen.
    <div className="grid h-full min-h-0 w-full grid-cols-[240px_1fr]">
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
              isActive && SELECTED_ROW,
            )}
            data-testid={`settings-tab-${tab.key}`}
          >
            {tab.icon && <tab.icon size={16} className="flex-none text-fg-dim" />}
            <span className="flex-1">{tab.label}</span>
            {tab.soon && <span className="rounded-full border border-border px-1.5 text-[10px] leading-4 text-fg-dim">{t("settings.soon")}</span>}
          </NavLink>
        ))}
      </nav>
      {/* #735: the PADDING lives here and nowhere else. It used to be each tab's own `p-6`, which is a
          convention a new tab cannot see — SCIM (#723) and custom domains (#721) were both written
          without it and both shipped flush against the rail, measured at 0px on every side. A rule that
          only holds while everybody remembers it is not a rule; this is the one place a tab cannot
          forget, because it does not write it.

          Unconditional, and NOT `SettingsPane`'s job: a tab that forgets the pane now renders full
          width — legible, if wide — instead of touching the window edge. The failure mode is the point. */}
      <section className="min-h-0 min-w-0 overflow-y-auto p-6">{children}</section>
    </div>
  );
}

// Shown when a screen is reached without authority. The wording differs by reason
// so the UI matches the leak rule (404 hides existence; 403 admits it but denies).
export function SettingsDenied({ kind }: { kind: "forbidden" | "notFound" }) {
  const { t } = useTranslation();
  return (
    <div data-settings-pane="form" className={`${SETTINGS_WIDTHS.form} py-2 text-fg-dim`} data-testid={kind === "forbidden" ? "settings-forbidden" : "settings-notfound"}>
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
    <div data-settings-pane="form" className={`${SETTINGS_WIDTHS.form} py-2 text-fg-dim`} data-testid="settings-placeholder">
      <h2 className="mt-0 text-foreground">{label}</h2>
      <p>{t("settings.placeholder")}</p>
    </div>
  );
}

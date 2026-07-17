import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageToggle } from "./LanguageToggle";
import { UserMenu } from "./UserMenu";
import { NotificationBell } from "../notifications/NotificationBell";
import { TenantBrand } from "./BrandLockup";
import { FirstRunOnboarding } from "./EditorOnboarding";
import { useBranding } from "../data/queries";
import { assetUrl } from "../data/apiClient";

// App skeleton: header / sidebar slot / main content. `sidebar` holds the page
// tree and `search` the search box — both member-only; guest (share) routes pass
// neither. `onLogout`, when given, renders a logout control (member chrome only).
// The sidebar collapses via the header toggle (choice persists); the collapse is
// ANIMATED — the sidebar grid column slides 260px → 0 (no display:none), with the
// aside clipping its content. When fully collapsed the aside is 0-wide, so the
// sidebar is genuinely hidden.
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
    <div
      // collapse the sidebar column to 0 when the user collapses it OR when there is no
      // sidebar at all (settings screens) — otherwise the empty 260px column sat there as
      // a "ghost" panel, pushing the content right and breaking the centering.
      data-collapsed={!sidebar || collapsed ? "true" : "false"}
      className="grid h-full grid-cols-[var(--sidebar-w)_1fr] grid-rows-[var(--header-h)_1fr] [grid-template-areas:'header_header''sidebar_main'] transition-[grid-template-columns] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] data-[collapsed=true]:grid-cols-[0px_1fr]"
    >
      <header className="flex items-center gap-2 border-b border-border bg-panel px-4 [grid-area:header]">
        {/* #274: no decorative icon when there is no sidebar — a non-interactive PanelLeft read as a
            broken "expand sidebar" control on the guest page / settings shells. */}
        {sidebar && (
          <button type="button" className="flex rounded p-1 text-fg-dim transition-colors hover:bg-panel-2 hover:text-foreground" aria-label={t("nav.toggleSidebar")} aria-pressed={!collapsed} data-testid="sidebar-toggle" onClick={toggle}>
            <PanelLeft size={16} />
          </button>
        )}
        {/* Brand: tenant logo ▷ tenant display name ▷ the Wikistead lockup. In member
            chrome (any page WITH a logout control — page route AND settings) it links
            Home (→ default page); guests/pre-login get a static brand (no home). Gate
            on onLogout, NOT sidebar: the settings shell has no sidebar but is a member. */}
        {(() => {
          // #143: the header brand is ALWAYS two INDEPENDENT slots — a logo slot and a name slot —
          // each with its own default. Logo slot: the custom uploaded logo when set, else the default
          // Wikistead mark. Name slot: the tenant display name when set, else "Wikistead". Setting a
          // logo never hides the name; setting a name never hides the (default) logo. (Was exclusive:
          // a logo replaced the name and a name replaced the default logo — the #143 bounce.)
          // #442: the SAME TenantBrand component the sign-in card renders — the header's own copy
          // drifted (inherited line-height mis-centred the name against the mark).
          const brand = <TenantBrand logoUrl={branding.data?.logoUrl} name={branding.data?.displayName} size="header" />;
          return onLogout ? (
            <Link to="/" className="flex items-center rounded outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("nav.home")} data-testid="brand-home">{brand}</Link>
          ) : brand;
        })()}
        <div className="flex-1" />
        {search && <div className="flex justify-end">{search}</div>}
        <LanguageToggle />
        <ThemeToggle />
        {/* #320 / ADR-126: the notification bell is member-only (guests have no inbox); onLogout marks a
            member shell (guest/loading shells pass none), so it gates the bell without a separate prop. */}
        {onLogout && <NotificationBell />}
        {onLogout && <UserMenu onLogout={onLogout} />}
      </header>
      {/* Only render the sidebar panel when there IS one; on settings screens (no
          sidebar) it would be an empty bordered panel column. */}
      {sidebar && <aside className="box-border min-w-0 overflow-hidden border-r border-border bg-panel [grid-area:sidebar]">{sidebar}</aside>}
      <main className="min-h-0 min-w-0 overflow-hidden [grid-area:main]">{children}</main>
      {/* #289 / ADR-115: the first-run persona enrollment + existing-user banner. MEMBER-ONLY (#355):
          gate on the member-shell signal (onLogout — guest/share/loading shells pass none), NOT just the
          inner DATA gate. In dev/e2e VITE_DEV_TOKEN forces status="authed" even on a guest share route, so the
          data gate alone let the member banner leak onto the guest surface (a #289 structure violation). The
          member banner/modal is now only mounted where a member session actually owns the shell (fail-closed). */}
      {onLogout && <FirstRunOnboarding />}
    </div>
  );
}

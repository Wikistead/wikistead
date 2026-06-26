import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageToggle } from "./LanguageToggle";
import { UserMenu } from "./UserMenu";
import { BrandLockup } from "./BrandLockup";
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
        {sidebar ? (
          <button type="button" className="flex rounded p-1 text-fg-dim transition-colors hover:bg-panel-2 hover:text-foreground" aria-label={t("nav.toggleSidebar")} aria-pressed={!collapsed} data-testid="sidebar-toggle" onClick={toggle}>
            <PanelLeft size={16} />
          </button>
        ) : (
          <PanelLeft size={16} aria-hidden />
        )}
        {/* Brand: tenant logo ▷ tenant display name ▷ the Wikistead lockup. In member
            chrome (any page WITH a logout control — page route AND settings) it links
            Home (→ default page); guests/pre-login get a static brand (no home). Gate
            on onLogout, NOT sidebar: the settings shell has no sidebar but is a member. */}
        {(() => {
          const brand = branding.data?.logoUrl ? (
            <img className="block h-[22px] max-w-[160px] object-contain" src={assetUrl(branding.data.logoUrl)} alt={branding.data.displayName || "Wikistead"} data-testid="brand-logo" />
          ) : branding.data?.displayName ? (
            <span className="text-[15px] font-semibold" data-testid="brand">{branding.data.displayName}</span>
          ) : (
            <BrandLockup />
          );
          return onLogout ? (
            <Link to="/" className="flex items-center rounded outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("nav.home")} data-testid="brand-home">{brand}</Link>
          ) : brand;
        })()}
        <div className="flex-1" />
        {search && <div className="flex justify-end">{search}</div>}
        <LanguageToggle />
        <ThemeToggle />
        {onLogout && <UserMenu onLogout={onLogout} />}
      </header>
      {/* Only render the sidebar panel when there IS one; on settings screens (no
          sidebar) it would be an empty bordered panel column. */}
      {sidebar && <aside className="box-border min-w-0 overflow-hidden border-r border-border bg-panel [grid-area:sidebar]">{sidebar}</aside>}
      <main className="min-h-0 min-w-0 overflow-hidden [grid-area:main]">{children}</main>
    </div>
  );
}

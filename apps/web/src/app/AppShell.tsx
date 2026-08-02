import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "./product-name";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageToggle } from "./LanguageToggle";
import { UserMenu } from "./UserMenu";
import { NotificationBell } from "../notifications/NotificationBell";
import { TenantBrand } from "./BrandLockup";
import { FirstRunOnboarding } from "./EditorOnboarding";
import { useMediaQuery } from "./PageControls";
import { useBranding } from "../data/queries";
import { assetUrl } from "../data/apiClient";

// App skeleton: header / sidebar slot / main content. `sidebar` holds the page
// tree and `search` the search box — both member-only; guest (share) routes pass
// neither. `onLogout`, when given, renders a logout control (member chrome only).
// Desktop (md+): the sidebar collapses via the header toggle (choice persists);
// the collapse is ANIMATED — the sidebar grid column slides 260px → 0.
// #406 S1 / ADR-159 §3: below md the SAME sidebar renders as an off-canvas DRAWER
// over a scrim — default-closed, opened by the same header toggle, closed by scrim
// tap / Esc / navigating. The `wks.sidebarCollapsed` key stays a DESKTOP preference:
// the drawer's open state is ephemeral and never touches it. One code path serves
// the member, guest and public shells (they all route through AppShell).
export function AppShell({
  children,
  sidebar,
  search,
  onLogout,
  headerExtra,
}: {
  children: ReactNode;
  sidebar?: ReactNode;
  search?: ReactNode;
  onLogout?: () => void;
  headerExtra?: ReactNode; // #430: the public space reader's "Powered by Wikistead" marker (free plan)
}) {
  const { t } = useTranslation();
  const branding = useBranding();
  useDocumentTitle(); // #575 slice C: the tab says what this workspace is called, not a build-time literal
  const isMobile = useMediaQuery("(max-width: 767px)"); // Tailwind `md` cut (ADR-159 §2)
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("wks.sidebarCollapsed") === "1"; } catch { return false; }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const toggle = () => {
    if (isMobile) { setDrawerOpen((v) => !v); return; } // ephemeral — never writes the desktop key
    setCollapsed((v) => {
      const n = !v;
      try { localStorage.setItem("wks.sidebarCollapsed", n ? "1" : "0"); } catch { /* no storage */ }
      return n;
    });
  };

  // Drawer lifecycle: close on navigation and when leaving the mobile breakpoint; Esc closes; focus
  // moves into the drawer while open and returns to the toggle on close (the scrimmed-overlay contract).
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  useEffect(() => { if (!isMobile) setDrawerOpen(false); }, [isMobile]);
  useEffect(() => {
    if (!drawerOpen) return;
    drawerRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setDrawerOpen(false); toggleRef.current?.focus(); return; }
      // minimal focus containment: Tab wraps inside the drawer while it is open
      if (e.key === "Tab" && drawerRef.current) {
        const focusables = drawerRef.current.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])",
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!, last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (!drawerRef.current.contains(active)) { e.preventDefault(); first.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div
      // collapse the sidebar column to 0 when the user collapses it, when there is no sidebar at
      // all (settings screens), OR below md (the drawer replaces the docked column) — otherwise the
      // empty 260px column sat there as a "ghost" panel, pushing the content right.
      data-collapsed={!sidebar || collapsed || isMobile ? "true" : "false"}
      className="grid h-full grid-cols-[var(--sidebar-w)_1fr] grid-rows-[var(--header-h)_1fr] [grid-template-areas:'header_header''sidebar_main'] transition-[grid-template-columns] duration-[240ms] ease-[cubic-bezier(0.2,0,0,1)] data-[collapsed=true]:grid-cols-[0px_1fr]"
    >
      <header className="flex items-center gap-2 border-b border-border bg-panel px-4 [grid-area:header]">
        {/* #274: no decorative icon when there is no sidebar — a non-interactive PanelLeft read as a
            broken "expand sidebar" control on the guest page / settings shells. */}
        {sidebar && (
          <button ref={toggleRef} type="button" className="flex rounded p-1 text-fg-dim transition-colors hover:bg-panel-2 hover:text-foreground" aria-label={t("nav.toggleSidebar")} aria-pressed={isMobile ? drawerOpen : !collapsed} data-testid="sidebar-toggle" onClick={toggle}>
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
        {/* #406 S1 (ADR-159 §3 header): below md the standalone language/theme toggles fold away in
            MEMBER chrome (the account menu carries them there); guest/pre-login shells have no account
            menu, so they keep the compact toggles at every width. */}
        <div className={onLogout ? "hidden items-center gap-2 md:flex" : "flex items-center gap-2"}>
          <LanguageToggle />
          <ThemeToggle />
        </div>
        {/* #320 / ADR-126: the notification bell is member-only (guests have no inbox); onLogout marks a
            member shell (guest/loading shells pass none), so it gates the bell without a separate prop. */}
        {onLogout && <NotificationBell />}
        {onLogout && <UserMenu onLogout={onLogout} />}
      </header>
      {/* Only render the docked sidebar panel when there IS one AND we're on desktop; on settings
          screens (no sidebar) it would be an empty bordered panel column, and below md the drawer
          (fixed overlay below) replaces the docked column entirely. */}
      {sidebar && !isMobile && <aside className="box-border min-w-0 overflow-hidden border-r border-border bg-panel [grid-area:sidebar]">{sidebar}</aside>}
      {sidebar && isMobile && drawerOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40" data-testid="drawer-scrim" onClick={() => { setDrawerOpen(false); toggleRef.current?.focus(); }} />
          <aside
            ref={drawerRef}
            tabIndex={-1}
            data-testid="mobile-drawer"
            className="fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] overflow-y-auto border-r border-border bg-panel shadow-xl outline-none"
          >
            {sidebar}
          </aside>
        </>
      )}
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

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { TenantBrand } from "./BrandLockup";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageToggle } from "./LanguageToggle";
import { useBranding } from "../data/queries";
import { assetUrl } from "../data/apiClient";
import { Button } from "../ui/Button";
import { SocialIcon } from "./SocialIcon";

// #261: the sign-in screen (real auth mode). A centred, branded card — the tenant logo/name (public
// /branding) ▷ the Wikistead lockup — kicks off the OIDC flow as a top-level navigation to /auth/login
// (preserving where the user wanted to go). The auth callback redirects failures to /login?error=<kind>;
// this screen surfaces that so a denied/seat-full sign-in isn't silent. `access` stays VAGUE (no IdP-subject
// enumeration — matches the server's existence-hiding).
// #281 / ADR-121 §2: which social buttons to render — the PUBLIC login-options endpoint
// (slugs only; empty on CE / tenant-OIDC tenants, so the buttons simply don't render).
const SOCIAL_LABELS: Record<string, string> = { google: "Google", github: "GitHub", microsoft: "Microsoft" };
// #537 §6: the screen shows what is OPEN — the method kinds are published facts (ADR-195 §7). On
// fetch failure we fall back to the historical single-button screen (fail-open DISPLAY only; every
// button is still a server-refused URL — the UI is convenience, the server is the fortress).
export interface LoginConnection { id: string; kind: string; label: string | null; brand: string | null }
interface LoginOptions { social: string[]; methods: string[]; connections?: LoginConnection[] }
function useLoginOptions(): LoginOptions {
  const q = useQuery({
    queryKey: ["login-options"],
    queryFn: () =>
      fetch(assetUrl("/auth/login-options"))
        .then((r) => (r.ok ? (r.json() as Promise<{ social?: string[]; methods?: string[]; connections?: LoginConnection[] }>) : null))
        .catch(() => null),
    staleTime: 60_000,
  });
  // Render only KNOWN providers (branding assets exist for these); unknown slugs are ignored.
  // A pre-#537 server (no `methods` field) or a failed fetch degrades to the plain OIDC button.
  return {
    social: (q.data?.social ?? []).filter((s) => s in SOCIAL_LABELS),
    methods: q.data ? (q.data.methods ?? ["oidc"]) : ["oidc"],
    connections: q.data?.connections,
  };
}

// #554 S3 / ADR-197 §3: the screen's truth is the ordered CONNECTION list — the first entry is the
// primary (large) button, the rest fold behind "sign in another way". A server without the list (or
// a failed fetch) degrades to the legacy method synthesis, whose empty ids make every URL the
// connection-less legacy start — N=1 renders byte-identically to the old screen. Pure for tests.
export function connectionsFor(connections: LoginConnection[] | undefined, methods: string[]): LoginConnection[] {
  if (connections) return connections;
  const out: LoginConnection[] = [];
  if (methods.includes("oidc")) out.push({ id: "", kind: "oidc", label: null, brand: null });
  if (methods.includes("saml")) out.push({ id: "", kind: "saml", label: null, brand: null });
  return out;
}

// The start URL for one connection. SAML has its own route (one per tenant — no id needed); an
// empty id is the legacy connection-less start (byte-compat fallback).
export function connectionStartUrl(conn: LoginConnection, returnTo: string): string {
  const rt = `returnTo=${encodeURIComponent(returnTo)}`;
  if (conn.kind === "saml") return `/auth/saml/login?${rt}`;
  return conn.id ? `/auth/login?connection=${encodeURIComponent(conn.id)}&${rt}` : `/auth/login?${rt}`;
}

// #554 S3 review (finding 4): the button wording per kind — ADR-197 §3 rev3 gives the PLATFORM
// connection fixed first-party branding of its own (it is not admin data, so it never waited for
// S4's label column); SAML keeps its fixed wording; an oidc connection wears its admin label once
// S4 ships the column, generic SSO wording until then. Pure for tests.
export function connectionButtonText(conn: LoginConnection, t: (k: string, o?: Record<string, string>) => string): string {
  if (conn.kind === "saml") return t("auth.signInSaml");
  if (conn.kind === "platform") return t("auth.signInPlatform");
  // #554 S4: a PRESET connection wears its fixed first-party brand ("Continue with Google") —
  // rev3: the label field never carries through a branded connection (the server enforces it;
  // this is display truth, not a gate).
  if (conn.brand && conn.brand in SOCIAL_LABELS) return t("auth.continueWith", { provider: SOCIAL_LABELS[conn.brand]! });
  return conn.label ?? t("auth.signIn");
}

// #554 S3 review N4: the social start URL, pure and pinned. It must NAME the platform connection —
// the bare URL starts the legacy pick, which is the tenant IdP once one exists, and the provider
// hint is then silently dropped (the worst failure shape: "Continue with Google" launching the
// corporate IdP). Empty platformId = pre-S3 server, where social only rendered when platform WAS
// the pick, so the bare URL stays correct there.
export function socialStartUrl(platformId: string, slug: string, returnTo: string): string {
  const conn = platformId ? `connection=${encodeURIComponent(platformId)}&` : "";
  return `/auth/login?${conn}provider=${encodeURIComponent(slug)}&returnTo=${encodeURIComponent(returnTo)}`;
}

function useAuthError(): string | null {
  const { t } = useTranslation();
  const kind = new URLSearchParams(window.location.search).get("error");
  if (!kind) return null;
  if (kind === "seat_full") return t("auth.errorSeatFull");
  // #346: the IdP was unreachable / misconfigured when starting login — a "temporarily unavailable"
  // message (distinct from access-denied), still vague about WHICH IdP (no enumeration / config leak).
  if (kind === "idp_unavailable") return t("auth.errorIdpUnavailable");
  // access / auth / saml all collapse to a single vague message — never reveal WHY (no enumeration).
  return t("auth.errorAccess");
}

export function LoginScreen() {
  const { t } = useTranslation();
  const branding = useBranding();
  const returnTo = window.location.pathname === "/login" ? "/" : window.location.pathname + window.location.search;
  const error = useAuthError();
  const { social, methods, connections } = useLoginOptions();
  const conns = connectionsFor(connections, methods);
  const primary = conns[0] ?? null;
  const secondary = conns.slice(1);
  const platformId = conns.find((c) => c.kind === "platform")?.id ?? "";
  const logoUrl = branding.data?.logoUrl;
  const name = branding.data?.displayName;
  // #371: sign-in navigates top-level to /auth/login (then the IdP), which can take a beat. Show a spinner on the
  // clicked button and lock the others so the click reads as "working" instead of dead. Navigate from an EFFECT
  // (not inline in the handler) so React commits+paints the spinner BEFORE the browser starts unloading — a
  // synchronous `location.href =` right after setState would navigate before the spinner ever renders. The state
  // persists until the page unloads, so no reset is needed.
  const [pending, setPending] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => { if (pending) window.location.href = pending.url; }, [pending]);
  const navigating = pending?.key ?? null;
  const go = (key: string, url: string) => setPending({ key, url });

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-1 px-4 py-3">
        <div className="flex-1" />
        <LanguageToggle />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm rounded-xl border border-border bg-panel p-8 shadow-md" data-testid="login-card">
          <div className="mb-6">
            {/* #442: the shared TenantBrand lockup (same component as the app header). */}
            <TenantBrand logoUrl={logoUrl} name={name} size="login" logoTestId="login-brand-logo" nameTestId="login-brand" />
          </div>
          <h1 className="mb-1 text-xl font-semibold">{t("auth.signInTitle")}</h1>
          <p className="mb-5 text-sm text-fg-dim">{t("auth.signInBody")}</p>
          {error && (
            <div
              className="mb-4 rounded-md border border-border border-l-[3px] border-l-[var(--danger)] bg-panel-2 px-3 py-2 text-sm"
              data-testid="login-error"
              role="alert"
            >
              {error}
            </div>
          )}
          {primary !== null && (
            <Button
              variant="primary"
              className="w-full"
              data-testid="login-signin"
              disabled={navigating !== null}
              onClick={() => go("signin", connectionStartUrl(primary, returnTo))}
            >
              {navigating === "signin" && <Loader2 size={16} className="animate-spin" data-testid="login-spinner" />}
              {connectionButtonText(primary, t)}
            </Button>
          )}
          {primary === null && (
            <p className="text-sm text-fg-dim" data-testid="login-none">{t("auth.noMethods")}</p>
          )}
          {/* #554 S3 / ADR-197 §3: every non-primary connection folds behind "sign in another way",
              in the tenant's sort order. rev3 labels: a free label renders only when the server sent
              one (preset-less custom OIDC — S4 fills the column); everything else wears fixed
              first-party wording. */}
          {secondary.length > 0 && (
            <details className="mt-4" data-testid="login-more">
              <summary className="cursor-pointer text-xs text-fg-dim">{t("auth.moreWays")}</summary>
              <div className="mt-2 flex flex-col gap-2">
                {secondary.map((c, i) => (
                  <Button
                    key={c.id || `${c.kind}-${i}`}
                    variant="default"
                    className="w-full"
                    data-testid={c.kind === "saml" ? "login-saml" : `login-conn-${c.id || i}`}
                    disabled={navigating !== null}
                    onClick={() => go(c.id || c.kind, connectionStartUrl(c, returnTo))}
                  >
                    {navigating === (c.id || c.kind) && <Loader2 size={16} className="animate-spin" data-testid="login-spinner" />}
                    {connectionButtonText(c, t)}
                  </Button>
                ))}
              </div>
            </details>
          )}
          {social.length > 0 && (
            <div className="mt-4 border-t border-border pt-4" data-testid="login-social">
              <p className="mb-2 text-xs text-fg-dim">{t("auth.socialHint")}</p>
              <div className="flex flex-col gap-2">
                {social.map((slug) => (
                  <Button
                    key={slug}
                    variant="default"
                    className="w-full"
                    data-testid={`login-social-${slug}`}
                    disabled={navigating !== null}
                    onClick={() => go(slug, socialStartUrl(platformId, slug, returnTo))}
                  >
                    <span className="inline-flex items-center gap-2">
                      {navigating === slug ? <Loader2 size={16} className="animate-spin" data-testid="login-spinner" /> : <SocialIcon slug={slug} />}
                      {t("auth.continueWith", { provider: SOCIAL_LABELS[slug] })}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

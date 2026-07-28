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
interface LoginOptions { social: string[]; methods: string[] }
function useLoginOptions(): LoginOptions {
  const q = useQuery({
    queryKey: ["login-options"],
    queryFn: () =>
      fetch(assetUrl("/auth/login-options"))
        .then((r) => (r.ok ? (r.json() as Promise<{ social?: string[]; methods?: string[] }>) : null))
        .catch(() => null),
    staleTime: 60_000,
  });
  // Render only KNOWN providers (branding assets exist for these); unknown slugs are ignored.
  // A pre-#537 server (no `methods` field) or a failed fetch degrades to the plain OIDC button.
  return {
    social: (q.data?.social ?? []).filter((s) => s in SOCIAL_LABELS),
    methods: q.data ? (q.data.methods ?? ["oidc"]) : ["oidc"],
  };
}

// §6 layout, pure for tests: the PRIMARY method gets the large button; everything else folds behind
// "sign in another way". OIDC outranks SAML as primary (the common case); with a single method the
// fold renders nothing (degrades to today's screen).
export function loginLayout(methods: string[]): { primary: "oidc" | "saml" | null; secondary: "saml"[] } {
  const primary = methods.includes("oidc") ? "oidc" : methods.includes("saml") ? "saml" : null;
  const secondary = primary === "oidc" && methods.includes("saml") ? (["saml"] as "saml"[]) : [];
  return { primary, secondary };
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
  const { social, methods } = useLoginOptions();
  const layout = loginLayout(methods);
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
          {layout.primary !== null && (
            <Button
              variant="primary"
              className="w-full"
              data-testid="login-signin"
              disabled={navigating !== null}
              onClick={() =>
                go(
                  "signin",
                  layout.primary === "saml"
                    ? `/auth/saml/login?returnTo=${encodeURIComponent(returnTo)}`
                    : `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
                )
              }
            >
              {navigating === "signin" && <Loader2 size={16} className="animate-spin" data-testid="login-spinner" />}
              {layout.primary === "saml" ? t("auth.signInSaml") : t("auth.signIn")}
            </Button>
          )}
          {layout.primary === null && (
            <p className="text-sm text-fg-dim" data-testid="login-none">{t("auth.noMethods")}</p>
          )}
          {/* #281 / ADR-121: Cloud social sign-in — deep-links the platform flow with the provider
              pre-selected (?provider=<slug>; the server allowlists it). Absent on CE / tenant OIDC. */}
          {/* #537 §6: everything that is not the primary folds behind "sign in another way". */}
          {layout.secondary.length > 0 && (
            <details className="mt-4" data-testid="login-more">
              <summary className="cursor-pointer text-xs text-fg-dim">{t("auth.moreWays")}</summary>
              <div className="mt-2 flex flex-col gap-2">
                <Button
                  variant="default"
                  className="w-full"
                  data-testid="login-saml"
                  disabled={navigating !== null}
                  onClick={() => go("saml", `/auth/saml/login?returnTo=${encodeURIComponent(returnTo)}`)}
                >
                  {navigating === "saml" && <Loader2 size={16} className="animate-spin" data-testid="login-spinner" />}
                  {t("auth.signInSaml")}
                </Button>
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
                    onClick={() => go(slug, `/auth/login?provider=${encodeURIComponent(slug)}&returnTo=${encodeURIComponent(returnTo)}`)}
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

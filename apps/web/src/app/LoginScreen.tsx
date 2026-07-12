import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { WikisteadMark } from "./BrandLockup";
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
function useLoginOptions(): string[] {
  const q = useQuery({
    queryKey: ["login-options"],
    queryFn: () =>
      fetch(assetUrl("/auth/login-options"))
        .then((r) => (r.ok ? (r.json() as Promise<{ social?: string[] }>) : null))
        .then((r) => r?.social ?? [])
        .catch(() => []),
    staleTime: 60_000,
  });
  // Render only KNOWN providers (branding assets exist for these); unknown slugs are ignored.
  return (q.data ?? []).filter((s) => s in SOCIAL_LABELS);
}

function useAuthError(): string | null {
  const { t } = useTranslation();
  const kind = new URLSearchParams(window.location.search).get("error");
  if (!kind) return null;
  if (kind === "seat_full") return t("auth.errorSeatFull");
  // access / auth / saml all collapse to a single vague message — never reveal WHY (no enumeration).
  return t("auth.errorAccess");
}

export function LoginScreen() {
  const { t } = useTranslation();
  const branding = useBranding();
  const returnTo = window.location.pathname === "/login" ? "/" : window.location.pathname + window.location.search;
  const error = useAuthError();
  const social = useLoginOptions();
  const logoUrl = branding.data?.logoUrl;
  const name = branding.data?.displayName;

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-1 px-4 py-3">
        <div className="flex-1" />
        <LanguageToggle />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm rounded-xl border border-border bg-panel p-8 shadow-md" data-testid="login-card">
          <div className="mb-6 flex items-center gap-2">
            {logoUrl
              ? <img className="block h-7 max-w-[180px] object-contain" src={assetUrl(logoUrl)} alt={name || "Wikistead"} data-testid="login-brand-logo" />
              : <WikisteadMark />}
            <span className="text-lg font-semibold" data-testid="login-brand">{name || "Wikistead"}</span>
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
          <Button
            variant="primary"
            className="w-full"
            data-testid="login-signin"
            onClick={() => { window.location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`; }}
          >
            {t("auth.signIn")}
          </Button>
          {/* #281 / ADR-121: Cloud social sign-in — deep-links the platform flow with the provider
              pre-selected (?provider=<slug>; the server allowlists it). Absent on CE / tenant OIDC. */}
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
                    onClick={() => { window.location.href = `/auth/login?provider=${encodeURIComponent(slug)}&returnTo=${encodeURIComponent(returnTo)}`; }}
                  >
                    <span className="inline-flex items-center gap-2">
                      <SocialIcon slug={slug} />
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

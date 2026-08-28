// #1005 / ADR-260 §3.1: mail locale resolution built on the shared vocabulary. #1006 landed the
// package both apps/web and apps/server depend on (@wikistead/i18n-shared) — LANGS/Lang/isKnownLang
// are re-exported from there rather than declared here, closing out #1005's temporary local copy.
import { LANGS, isKnownLang, type Lang } from '@wikistead/i18n-shared'
export { LANGS, isKnownLang }
export type { Lang }

// ADR-260 §3.1: the member's own locale, then the tenant default, then 'en' — collected in one place
// so every caller resolves the same way. §3.4: an unknown/unset locale is never an error, only 'en'.
export function resolveMailLocale(memberLocale: string | null, tenantDefaultLang: string | null): Lang {
  if (isKnownLang(memberLocale)) return memberLocale
  if (isKnownLang(tenantDefaultLang)) return tenantDefaultLang
  return 'en'
}

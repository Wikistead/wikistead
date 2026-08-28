// #1005 / ADR-260 §3.1: the two-language set every server-composed string (mail, the personal-space
// name) resolves against. Temporary local copy — #1006 lands a package both apps/web and apps/server
// depend on, and this becomes a re-export of that list rather than a second one (ADR-260 §3.3 forbids
// exactly the split a second copy would start).
export const LANGS = ['en', 'ja'] as const
export type Lang = (typeof LANGS)[number]

export function isKnownLang(v: string | null | undefined): v is Lang {
  return v != null && (LANGS as readonly string[]).includes(v)
}

// ADR-260 §3.1: the member's own locale, then the tenant default, then 'en' — collected in one place
// so every caller resolves the same way. §3.4: an unknown/unset locale is never an error, only 'en'.
export function resolveMailLocale(memberLocale: string | null, tenantDefaultLang: string | null): Lang {
  if (isKnownLang(memberLocale)) return memberLocale
  if (isKnownLang(tenantDefaultLang)) return tenantDefaultLang
  return 'en'
}

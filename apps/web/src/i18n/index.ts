import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import de from "./locales/de.json";
import { LANGS, isKnownLang, type Lang } from "@wikistead/i18n-shared";

// i18n foundation (Phase 3b-1). Default locale is English; Japanese is available.
// The active language is resolved once at startup (persisted choice ▷ browser
// locale ▷ English) and can be switched at runtime via the header LanguageToggle.
// Japanese is core to the product's positioning, so reaching it must not require
// editing config — the switcher (Phase 5) is that launch-required path.
// #1006 / ADR-260 §6.4: re-exported rather than declared here — apps/server's mail locale resolver
// reads the SAME list, and a second copy of a two-item array is exactly the drift ADR-260 forbids.
export { LANGS };
export type { Lang };
const KEY = "wks.lang";

// #713-S1: reads LANGS rather than naming 'en'/'ja' directly, so a language added to LANGS (S2) is
// detected here without a second find-and-fix pass — the whole point of a registry.
export function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(KEY);
    if (isKnownLang(stored)) return stored;
  } catch { /* private mode → fall through */ }
  // First visit: follow the browser, matched against every registered language (not just Japanese),
  // else the product default (English). Two passes: an exact tag match first (so a registered
  // region-qualified code like "pt-BR" is preferred over a bare-subtag guess), then a primary-subtag
  // match (before any region, e.g. browser "de-AT" or registered "pt-BR" → "de"/"pt") so a browser or
  // a registered code carrying a region we don't otherwise distinguish still resolves.
  const nav = (typeof navigator !== "undefined" ? navigator.language : "").toLowerCase();
  const subtag = (s: string) => s.toLowerCase().split("-")[0];
  const list = LANGS as readonly string[];
  return (list.find((l) => l.toLowerCase() === nav) ??
    list.find((l) => subtag(l) === subtag(nav))) as Lang | undefined ?? "en";
}

const initial = detectLang();
if (typeof document !== "undefined") document.documentElement.lang = initial;

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ja: { translation: ja }, de: { translation: de } },
  lng: initial,
  fallbackLng: "en",
  interpolation: { escapeValue: false }, // React already escapes
});

// Switch language at runtime and persist the choice (+ keep <html lang> in sync).
export function setLang(lng: Lang): void {
  void i18n.changeLanguage(lng);
  try { localStorage.setItem(KEY, lng); } catch { /* private mode */ }
  if (typeof document !== "undefined") document.documentElement.lang = lng;
}

export default i18n;

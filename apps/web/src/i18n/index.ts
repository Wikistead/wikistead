import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import { LANGS, type Lang } from "@wikistead/i18n-shared";

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

function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "en" || stored === "ja") return stored;
  } catch { /* private mode → fall through */ }
  // First visit: follow the browser, else the product default (English).
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  return nav.toLowerCase().startsWith("ja") ? "ja" : "en";
}

const initial = detectLang();
if (typeof document !== "undefined") document.documentElement.lang = initial;

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ja: { translation: ja } },
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

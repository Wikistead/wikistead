import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

// i18n foundation (Phase 3b-1). Default locale is English; Japanese is available.
// Strings are migrated to keys in 3b-4 (full sweep) — this just stands up the
// machinery + a first keyed surface (the theme switcher) to verify it works.
// A language switcher / persisted preference can layer on later like the theme one.
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ja: { translation: ja } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false }, // React already escapes
});

export default i18n;

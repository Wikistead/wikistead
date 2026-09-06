import type { Lang } from "@wikistead/i18n-shared";

// #1159 (#713-S3 review bounce): Noto Sans SC and Noto Sans KR are loaded on demand, per the
// active UI locale, rather than imported unconditionally in main.tsx the way Noto Sans JP already is.
// Unconditional import measured at +613,540 bytes (+226,541 gzip) on the entry CSS every visitor
// downloads before first paint — the @font-face declarations themselves, not the (correctly
// unicode-range-subsetted) woff2 files behind them, which was the property the original wiring's
// safety argument checked. "CJK is heavy, per-language loading is required" (the ticket's own words)
// rules out shipping all of it to every visitor regardless of subsetting.
//
// Noto Sans JP stays unconditional in main.tsx — Japanese is core to the product's positioning
// (predates #713 and this ticket), not part of the #713 language expansion this fix is scoped to.
const CJK_FONT_PACKAGES: Partial<Record<Lang, () => Promise<unknown>[]>> = {
  "zh-Hans": () => [
    import("@fontsource/noto-sans-sc/400.css"),
    import("@fontsource/noto-sans-sc/500.css"),
    import("@fontsource/noto-sans-sc/700.css"),
  ],
  ko: () => [
    import("@fontsource/noto-sans-kr/400.css"),
    import("@fontsource/noto-sans-kr/500.css"),
    import("@fontsource/noto-sans-kr/700.css"),
  ],
};

const loaded = new Set<Lang>();

// Called once at startup with the resolved initial locale, and again from setLang() on every runtime
// switch — a language switch never requires a reload, so the font has to be able to arrive after the
// fact. Idempotent per language: a language already loaded is not re-imported.
export function loadCjkFont(lang: Lang): void {
  if (loaded.has(lang)) return;
  const load = CJK_FONT_PACKAGES[lang];
  if (!load) return;
  loaded.add(lang);
  for (const p of load()) void p;
}

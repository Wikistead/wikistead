import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// #1159 / #713-S3: Noto Sans SC (zh-Hans) and Noto Sans KR (ko) are loaded on demand, by locale, via
// apps/web/src/i18n/cjk-fonts.ts — NOT imported unconditionally in main.tsx the way Noto Sans JP
// still is. The original unconditional wiring was measured to cost every visitor +226KB gzip on the
// entry CSS regardless of the unicode-range subsetting that made the woff2 fetches themselves safe
// (review bounce, #1159) — subsetting protects the woff2 request, not the @font-face
// declaration's own weight. This pins the lazy wiring, and keeps the subsetting property pinned too
// (it is still what makes a SINGLE loaded family safe for readers of other scripts on the same page).
const ROOT = resolve(import.meta.dirname, "../../../..");
const MAIN = readFileSync(resolve(ROOT, "apps/web/src/main.tsx"), "utf8");
const CJK_FONTS = readFileSync(resolve(ROOT, "apps/web/src/i18n/cjk-fonts.ts"), "utf8");
const I18N_INDEX = readFileSync(resolve(ROOT, "apps/web/src/i18n/index.ts"), "utf8");
const TOKENS = readFileSync(resolve(ROOT, "apps/web/src/styles/tokens.css"), "utf8");
const PKG = JSON.parse(readFileSync(resolve(ROOT, "apps/web/package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

const NEW_FAMILIES = [
  { pkg: "@fontsource/noto-sans-sc", family: "Noto Sans SC", lang: "zh-Hans" },
  { pkg: "@fontsource/noto-sans-kr", family: "Noto Sans KR", lang: "ko" },
];

describe("#1159 / #713-S3: CJK font delivery is lazy, by locale", () => {
  it("both packages are declared dependencies (not devDependencies-only)", () => {
    for (const { pkg } of NEW_FAMILIES) {
      expect(PKG.dependencies[pkg], `${pkg} missing from apps/web dependencies`).toBeTruthy();
    }
  });

  it("main.tsx no longer imports SC/KR unconditionally (the regression this ticket fixed)", () => {
    for (const { pkg } of NEW_FAMILIES) {
      expect(MAIN, `main.tsx still eagerly imports ${pkg} — every visitor pays for it again`)
        .not.toContain(`"${pkg}/`);
    }
    // Noto Sans JP is deliberately untouched — it predates #713 and stays unconditional.
    expect(MAIN, "Noto Sans JP was removed too — that was not this ticket's scope").toContain("@fontsource/noto-sans-jp/400.css");
  });

  it("cjk-fonts.ts dynamically imports every weight the UI chain uses (400/500/700), per language", () => {
    for (const { pkg, lang, family } of NEW_FAMILIES) {
      const langKeyIdx = CJK_FONTS.indexOf(lang === "zh-Hans" ? `"zh-Hans"` : "ko:");
      expect(langKeyIdx, `cjk-fonts.ts: no entry keyed by ${lang} (${family})`).toBeGreaterThan(-1);
      for (const weight of ["400", "500", "700"]) {
        expect(CJK_FONTS, `cjk-fonts.ts: does not dynamically import ${pkg}/${weight}.css`)
          .toContain(`import("${pkg}/${weight}.css")`);
      }
    }
    // …and each language's block is genuinely scoped to its own package, not a shared list both
    // languages read from (which would load the wrong family for one of them).
    const scIdx = CJK_FONTS.indexOf('"zh-Hans"');
    const koIdx = CJK_FONTS.indexOf("ko:");
    const [firstIdx, firstPkg, secondPkg] = scIdx < koIdx
      ? [scIdx, "@fontsource/noto-sans-sc", "@fontsource/noto-sans-kr"]
      : [koIdx, "@fontsource/noto-sans-kr", "@fontsource/noto-sans-sc"];
    const firstBlock = CJK_FONTS.slice(firstIdx, Math.max(scIdx, koIdx));
    expect(firstBlock, `the first language's block references ${secondPkg} — blocks are not isolated`)
      .not.toContain(secondPkg);
    expect(firstBlock, `the first language's block is missing its own package ${firstPkg}`)
      .toContain(firstPkg);
  });

  it("loading is wired into both startup (detectLang) and runtime switching (setLang)", () => {
    expect(I18N_INDEX, "i18n/index.ts does not import loadCjkFont").toContain("loadCjkFont");
    expect(I18N_INDEX, "loadCjkFont is not called for the initial locale").toMatch(/loadCjkFont\(initial\)/);
    expect(I18N_INDEX, "loadCjkFont is not called from setLang() — a runtime switch would never load the font")
      .toMatch(/function setLang[\s\S]*loadCjkFont\(lng\)/);
  });

  it("tokens.css's --font chain still names both families (unchanged — this ticket did not touch it)", () => {
    const fontLine = TOKENS.match(/--font:\s*([^;]+);/)?.[1] ?? "";
    expect(fontLine, "--font declaration not found in tokens.css").not.toBe("");
    for (const { family } of NEW_FAMILIES) {
      expect(fontLine, `--font chain missing "${family}": ${fontLine}`).toContain(family);
    }
  });

  // ⚠️ break-check target: this is the property that makes loading exactly one CJK family safe for
  // readers of a different script encountering the odd stray glyph elsewhere on the same page.
  it("the installed CSS actually ships unicode-range-subsetted @font-face rules, not one giant file", () => {
    for (const { pkg } of NEW_FAMILIES) {
      const css = readFileSync(
        resolve(ROOT, "apps/web/node_modules", pkg, "400.css"), "utf8",
      );
      const faces = [...css.matchAll(/@font-face\s*{[^}]*}/g)];
      expect(faces.length, `${pkg}/400.css: expected multiple subset @font-face rules`).toBeGreaterThan(1);
      const withRange = faces.filter((f) => /unicode-range:/.test(f[0]));
      expect(withRange.length, `${pkg}/400.css: every @font-face rule should carry unicode-range`).toBe(faces.length);
    }
  });

  it("the referenced woff2 files actually exist on disk (no dead url() reference)", () => {
    for (const { pkg } of NEW_FAMILIES) {
      const dir = resolve(ROOT, "apps/web/node_modules", pkg);
      const css = readFileSync(resolve(dir, "400.css"), "utf8");
      const files = [...css.matchAll(/url\((\.\/files\/[^)]+\.woff2)\)/g)].map((m) => m[1]!);
      expect(files.length, `${pkg}/400.css: no woff2 url() references found`).toBeGreaterThan(0);
      for (const rel of files.slice(0, 3)) { // a sample, not all — this is a wiring pin, not a corpus walk
        expect(existsSync(resolve(dir, rel)), `${pkg}: ${rel} referenced but missing on disk`).toBe(true);
      }
    }
  });
});

// #1159 review bounce (user ruling, 2026-09-06): "show the right font per language" — the
// base chain's fixed order (Inter, JP, SC, KR) always hands a codepoint shared by JP and SC/KR to JP,
// so a zh-Hans or ko reader saw Japanese glyph forms for characters their own family also draws. This
// pins the ADR-217 rev (§2 exception) that moves the reader's own family to the front via `:lang()`,
// still as a chain (every other family stays as fallback) rather than a per-language face table.
describe("#1159: the CJK reader's own family leads the chain, in their own locale", () => {
  const CSS_STRIPPED = TOKENS.replace(/\/\*[\s\S]*?\*\//g, ""); // comments quote the retired form
  const chainOf = (selector: string) => {
    const at = CSS_STRIPPED.indexOf(selector);
    expect(at, `${selector} rule not found in tokens.css`).toBeGreaterThanOrEqual(0);
    const block = CSS_STRIPPED.slice(at, CSS_STRIPPED.indexOf("}", at));
    return block.match(/--font:\s*([^;]+);/)?.[1] ?? "";
  };

  it("a zh-Hans reader gets Noto Sans SC before Noto Sans JP", () => {
    const chain = chainOf(':root:lang(zh-Hans)');
    expect(chain, `:root:lang(zh-Hans) does not override --font: ${chain}`).not.toBe("");
    expect(chain.indexOf("Noto Sans SC"), `SC not before JP in: ${chain}`)
      .toBeLessThan(chain.indexOf("Noto Sans JP"));
  });

  it("a ko reader gets Noto Sans KR before Noto Sans JP", () => {
    const chain = chainOf(':root:lang(ko)');
    expect(chain, `:root:lang(ko) does not override --font: ${chain}`).not.toBe("");
    expect(chain.indexOf("Noto Sans KR"), `KR not before JP in: ${chain}`)
      .toBeLessThan(chain.indexOf("Noto Sans JP"));
  });

  it("every family stays in each override — reordering, not narrowing, the chain", () => {
    for (const selector of [':root:lang(zh-Hans)', ':root:lang(ko)']) {
      const chain = chainOf(selector);
      for (const family of ["Inter", "Noto Sans JP", "Noto Sans SC", "Noto Sans KR"]) {
        expect(chain, `${selector}: missing "${family}" — fallback narrowed, not reordered`).toContain(family);
      }
    }
  });

  it("ja and every other locale are untouched — no override rule names them", () => {
    expect(CSS_STRIPPED).not.toMatch(/:root:lang\(ja\)\s*\{[^}]*--font:/);
    expect(CSS_STRIPPED).not.toMatch(/:root:lang\(en\)\s*\{[^}]*--font:/);
  });
});

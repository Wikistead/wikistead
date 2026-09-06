import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// #713-S3: Noto Sans SC (zh-Hans) and Noto Sans KR (ko) delivered the same way Noto Sans JP already
// is — imported unconditionally in main.tsx, added to the --font proportional chain in tokens.css —
// rather than a new per-language loading mechanism. That is safe ONLY because every fontsource
// package here ships unicode-range-subsetted @font-face rules, so a non-CJK visitor's browser never
// fetches a CJK subset file even though the CSS declaring it is present. This pins BOTH halves: the
// wiring, and the subsetting property the wiring's safety depends on.
const ROOT = resolve(import.meta.dirname, "../../../..");
const MAIN = readFileSync(resolve(ROOT, "apps/web/src/main.tsx"), "utf8");
const TOKENS = readFileSync(resolve(ROOT, "apps/web/src/styles/tokens.css"), "utf8");
const PKG = JSON.parse(readFileSync(resolve(ROOT, "apps/web/package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

const NEW_FAMILIES = [
  { pkg: "@fontsource/noto-sans-sc", family: "Noto Sans SC" },
  { pkg: "@fontsource/noto-sans-kr", family: "Noto Sans KR" },
];

describe("#713-S3 CJK font delivery follows the Noto Sans JP precedent", () => {
  it("both packages are declared dependencies (not devDependencies-only)", () => {
    for (const { pkg } of NEW_FAMILIES) {
      expect(PKG.dependencies[pkg], `${pkg} missing from apps/web dependencies`).toBeTruthy();
    }
  });

  it("main.tsx imports every weight the UI chain actually uses (400/500/700, matching Noto Sans JP)", () => {
    for (const { pkg } of NEW_FAMILIES) {
      for (const weight of ["400", "500", "700"]) {
        expect(MAIN, `main.tsx does not import ${pkg}/${weight}.css`).toContain(`${pkg}/${weight}.css`);
      }
    }
  });

  it("tokens.css's --font chain names both families", () => {
    const fontLine = TOKENS.match(/--font:\s*([^;]+);/)?.[1] ?? "";
    expect(fontLine, "--font declaration not found in tokens.css").not.toBe("");
    for (const { family } of NEW_FAMILIES) {
      expect(fontLine, `--font chain missing "${family}": ${fontLine}`).toContain(family);
    }
  });

  // ⚠️ break-check target: this is the property that makes "import unconditionally" safe. If a
  // future fontsource major ships a single un-subsetted file per weight, every visitor pays for CJK.
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

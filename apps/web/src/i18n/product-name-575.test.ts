// #575 / ADR-200 rev3 slice A: the product name is a value, not a literal.
//
// The rename was ruled product-wide, so every user-visible use of the name has to come from
// somewhere a deployment can change. This is the discovery half of that: it walks the locale bundles
// and the web source, and fails when the name is WRITTEN rather than interpolated.
//
// Two exemptions, both named rather than pattern-matched:
//   - `"Wikistead Mono"` — the name of an OFL subset of Source Code Pro. #190 renamed the face TO
//     this deliberately; renaming it with the product would misattribute a typeface.
//   - the FALLBACK constants — one in the client, one on the server. A fallback has to be a literal
//     or it is not a fallback; there are exactly two, and they are listed by file.
//
// Package identifiers (`@wikistead/*`) are not user-visible and are not searched for here.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

const SRC = resolve(import.meta.dirname, "..");
const NAME = /Wikistead|wikistead/;

type Tree = { [k: string]: string | Tree };
const flatten = (tree: Tree, prefix = ""): [string, string][] =>
  Object.entries(tree).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === "string" ? [[key, v] as [string, string]] : flatten(v, key);
  });

/**
 * Locale keys allowed to say the name: the code face, which is a typeface and not the product.
 *
 * #633 retired the font picker, and with it the two keys that named "Wikistead Mono" to a reader. The
 * list is empty rather than deleted — the exemption is a real category (a typeface can share the
 * product's name), and the next copy that needs it should be added here rather than rediscovered.
 * The "exemptions are real keys" check below is what caught the removal.
 */
const FONT_KEYS: string[] = [];

/** Files allowed to hold a literal: the two fallbacks, plus the mark's own asset. */
const LITERAL_FILES = [
  "app/product-name.ts", // the client fallback
  "app/BrandLockup.tsx", // the mark's own accessible name, and the last-resort wordmark
  "assets/fonts/wikistead-mono.css", // the typeface
  "main.tsx", // imports the typeface stylesheet by path
];

const sources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(p) && !/\.(test|spec)\./.test(p)) out.push(p);
    }
  };
  walk(SRC);
  return out;
};

const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

describe("#575: the product name comes from the deployment, not from the source", () => {
  for (const [locale, dict] of Object.entries({ en, ja })) {
    it(`${locale}: no UI string writes the name`, () => {
      const offenders = flatten(dict as Tree)
        .filter(([k, v]) => NAME.test(v) && !FONT_KEYS.includes(k))
        .map(([k, v]) => `${k} = ${v}`);
      expect(offenders, "interpolate {{product}} instead").toEqual([]);
    });
  }

  it("no component writes the name outside the two fallbacks", () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      const rel = file.slice(SRC.length + 1);
      if (LITERAL_FILES.includes(rel)) continue;
      const body = withoutComments(readFileSync(file, "utf8"));
      // the package scope is an identifier, not a name on screen
      const stripped = body.replace(/@wikistead\/[a-z-]+/g, "").replace(/Wikistead Mono/g, "");
      if (NAME.test(stripped)) offenders.push(rel);
    }
    expect(offenders, "read it from useProductName() / useBrandName()").toEqual([]);
  });

  it("the exemptions are real files and real keys (guard against a stale allow-list)", () => {
    for (const rel of LITERAL_FILES) expect(() => readFileSync(join(SRC, rel), "utf8"), rel).not.toThrow();
    const enKeys = flatten(en as Tree).map(([k]) => k);
    for (const k of FONT_KEYS) expect(enKeys, k).toContain(k);
  });

  it("the interpolated strings actually take the placeholder", () => {
    for (const dict of [en, ja] as Tree[]) {
      const flat = Object.fromEntries(flatten(dict));
      for (const key of ["auth.signInTitle", "auth.joinTitle", "publicReader.poweredBy", "import.invalid"]) {
        expect(flat[key], `${key} interpolates the product name`).toContain("{{product}}");
      }
    }
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LANGS } from "./index";

// #713-S2 / ADR-228: the owner's ruling attached one non-negotiable condition to shipping machine
// translation ahead of a community that can proof it — every machine-translated string carries a mark
// on repo that says so. This pin is that condition's enforcement: a language landed in LANGS without a
// corresponding entry here is a silent violation of the ruling, not merely an incomplete translation.
//
// en and ja are exempt — they are the two human-authored locales this product shipped with, never
// machine-translated, and the ruling's condition was about the languages ADDED beyond them.
const HUMAN_AUTHORED = new Set(["en", "ja"]);

// Deliberately NOT inside locales/ — #645's own "the parity check covers every registered language"
// pin walks every *.json file in that directory and requires the set to equal LANGS exactly; a
// manifest sitting beside the real locale files would look like an unregistered language to it.
const MANIFEST_PATH = resolve(import.meta.dirname, "machine-translated.json");

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
}

describe("#713-S2: every non-original language is marked machine-translated or explicitly proofed", () => {
  it("the manifest is valid JSON and only carries boolean marks (plus its own doc comment)", () => {
    const manifest = readManifest();
    for (const [key, value] of Object.entries(manifest)) {
      if (key === "_comment") {
        expect(typeof value, "_comment must be a string").toBe("string");
        continue;
      }
      expect(typeof value, `${key}'s mark must be a boolean (true = unreviewed machine translation)`).toBe("boolean");
    }
  });

  it.each(LANGS.filter((l) => !HUMAN_AUTHORED.has(l)))(
    "%s has a machine-translation mark (present, not silently unmarked)",
    (lang) => {
      const manifest = readManifest();
      expect(
        Object.prototype.hasOwnProperty.call(manifest, lang),
        `${lang} is in LANGS but has no entry in machine-translated.json — a language added without ` +
          `deciding this is exactly the silent gap the owner's ruling forbade`,
      ).toBe(true);
    },
  );

  it("a language present in the manifest is also a real, registered language (no stale marks)", () => {
    const manifest = readManifest();
    const stale = Object.keys(manifest)
      .filter((k) => k !== "_comment")
      .filter((k) => !(LANGS as readonly string[]).includes(k));
    expect(stale, "machine-translated.json names a language LANGS does not carry").toEqual([]);
  });
});

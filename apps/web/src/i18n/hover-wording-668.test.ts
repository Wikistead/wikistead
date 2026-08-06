import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #668 (user): is hover translated word for word, and reads as nothing anyone
// says in Japanese.
//
// Asserted as the ABSENCE of the old phrasing across EVERY plural form, not the presence of the new
// one. A pin that looked for goes green the moment one form carries it — and
// `groupRolesMark` has two forms in English and one in Japanese, so "the string I checked was fixed"
// and "the string on screen was fixed" are different claims. #653 ③ shipped that exact gap one ticket
// earlier: the reworded title passed while the old one sat two lines up in a key nobody read.
const LOCALES = resolve(import.meta.dirname, "locales");
const load = (f: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(LOCALES, `${f}.json`), "utf8")) as Record<string, unknown>;

/** Every leaf value in the file, so a phrase cannot hide in a key this test did not think to name. */
function values(obj: unknown, path = ""): [string, string][] {
  if (typeof obj === "string") return [[path, obj]];
  if (typeof obj !== "object" || obj === null) return [];
  return Object.entries(obj as Record<string, unknown>)
    .flatMap(([k, v]) => values(v, path ? `${path}.${k}` : k));
}

describe("#668: hover is not translated word for word", () => {
  it("no Japanese string says 「ポイントする」", () => {
    // Swept over the WHOLE file rather than the one key the report named. The phrase came from
    // translating `hover`, and nothing stops the next person reaching for it in another panel.
    const bad = values(load("ja")).filter(([, v]) => v.includes("ポイントする"));
    expect(bad.map(([k]) => k), "「ポイントする」— hover の直訳です").toEqual([]);
  });

  it("no English string says \"Point at this\"", () => {
    const bad = values(load("en")).filter(([, v]) => v.includes("Point at this"));
    expect(bad.map(([k]) => k), 'the English it was translated from reads oddly too').toEqual([]);
  });

  it("the mark still says what it is and how to see more, in every plural form", () => {
    // The rewording must not have removed the two things the aria-label exists to carry. A screen
    // reader gets no tooltip, so the label is the only place either fact appears.
    const ja = load("ja") as { members: Record<string, string> };
    const en = load("en") as { members: Record<string, string> };
    const jaForms = Object.entries(ja.members).filter(([k]) => k.startsWith("groupRolesMark"));
    const enForms = Object.entries(en.members).filter(([k]) => k.startsWith("groupRolesMark"));
    expect(jaForms.length, "Japanese has one plural form").toBe(1);
    expect(enForms.length, "English has two").toBe(2);
    for (const [k, v] of jaForms) {
      expect(v, `${k}: says what the mark is`).toContain("グループ由来のロール");
      expect(v, `${k}: says how to see the breakdown`).toContain("カーソルを合わせると");
    }
    for (const [k, v] of enForms) {
      expect(v, `${k}: says what the mark is`).toMatch(/through a? ?groups?/);
      expect(v, `${k}: says how to see the breakdown`).toContain("Hover to see which");
    }
  });
});

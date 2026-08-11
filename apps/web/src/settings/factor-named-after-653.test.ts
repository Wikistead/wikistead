// @vitest-environment happy-dom
// #653 (ruling, re-ruled): a factor is named AFTER it exists, never before.
//
// The panel asked for a name first: an empty box, carrying an example nobody's device is called
// / "Work phone"), standing above the only two buttons on the screen. Naming is
// something you do to a thing you have — and most people have exactly one, so the answer is the kind,
// which the row already says by itself (#653 the fallback).
//
// It also removes the last thing left standing in #686 the zero-entrance panel: when the stance
// and the browser between them leave no kind addable, the add buttons hide and the name box remained,
// a form for an operation with no way to start it.
//
// ⚠️ THE PENCIL IS NOW THE ONLY ENTRANCE. Before, a name could be given at enrolment; the ruling
// removes that path, so the rename control has to work for EVERY kind — a regression there is now a
// factor nobody can name at all, rather than an inconvenience.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_FACTOR_KINDS } from "./factor-kind";

const PANEL = readFileSync(resolve(import.meta.dirname, "SecondFactorPanel.tsx"), "utf8");
const en = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales/en.json"), "utf8"));
const ja = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales/ja.json"), "utf8"));

/** Comments are prose: they may discuss the removed field without being it (four prior incidents). */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");
const CODE = codeOnly(PANEL);

describe("#653 no name is asked for before the factor exists", () => {
  it("the enrolment row has no name field", () => {
    expect(CODE, "the pre-enrolment name box is still on screen").not.toContain("factor-label-input");
    // …and the state behind it is gone too, rather than left feeding a hidden input.
    expect(CODE, "the field's state survives, so something still reads it").not.toMatch(/\bsetLabel\b/);
  });

  it("both enrolments START unnamed — the server is told nothing to name it", () => {
    // Computed over the kinds so a third one cannot quietly reintroduce a label argument. The two
    // mutations are the only places an enrolment begins.
    const starts = [...CODE.matchAll(/mutateAsync\(\{\s*label:\s*([^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(starts.length, "the enrolment calls were not found — the scan broke").toBe(ALL_FACTOR_KINDS.length);
    for (const arg of starts) {
      expect(arg, `an enrolment still sends a name: ${arg}`).toMatch(/^''\s*,?$/);
    }
  });

  it("the rename control is the one entrance, and it is on every row", () => {
    // Not gated on kind: the pencil is rendered for the row, whatever the row holds. A `kind ===`
    // anywhere near it would leave one kind unnameable now that enrolment cannot carry a name.
    expect(CODE).toContain('data-testid="factor-rename"');
    expect(CODE).toContain('data-testid="factor-rename-input"');
    expect(CODE).toContain('data-testid="factor-rename-save"');
    const row = CODE.slice(CODE.indexOf('data-testid="factor-row"'), CODE.indexOf('data-testid="factor-remove"'));
    expect(row, "the rename entrance is gated on the kind — one kind becomes unnameable")
      .not.toMatch(/f\.kind\s*===\s*['"]/);
  });

  it("an unnamed row still says what it is", () => {
    // The fallback #653 landed is what makes an unnamed row readable, and it is now load-bearing
    // rather than a nicety: every row starts unnamed.
    expect(CODE, "an unnamed row would render blank").toMatch(/f\.label\s*\|\|\s*factorKindName\(f\.kind, t\)/);
  });

  it("the example device name is gone from BOTH locales", () => {
    for (const [lang, dict] of [["en", en], ["ja", ja]] as const) {
      for (const key of ["factorLabel", "factorLabelPlaceholder"]) {
        expect(dict.account[key], `${lang}: ${key} survives the field it belonged to`).toBeUndefined();
      }
    }
    // The strings themselves, in case a copy lands under a different key.
    expect(JSON.stringify(ja)).not.toContain("仕事用のスマホ");
    expect(JSON.stringify(en)).not.toContain("Work phone");
    // …while the RENAME copy stays: it is the entrance now.
    for (const [lang, dict] of [["en", en], ["ja", ja]] as const) {
      expect(dict.account.factorRename?.length, `${lang}: the rename label went with it`).toBeGreaterThan(0);
    }
  });
});

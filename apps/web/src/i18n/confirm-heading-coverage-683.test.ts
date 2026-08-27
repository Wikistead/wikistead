// #683 (review rejection): the sweep has to be anchored to the SCREEN, not to a table.
//
// The first fix collected the two stance switches into `STANCE_COPY` and pinned a walk over it. The
// kind picker's confirmation was never in that table, so the walk could not see it — and it was still
// heading itself with the switch's label, "Require two-factor authentication", above a body asking
// whether to change which factors count on a tenant where the requirement was already on. The walk was
// green throughout.
//
// This ticket's own acceptance note had predicted it: "do not write a pin that enumerates four dialogs,
// because a third stance will arrive — it did in #679". The pin obeyed the letter (it iterated a table)
// and missed the point (the table was the enumeration).
//
// So the anchor is the FILE. Every `<ConfirmDialog` in the screen must be accounted for: in
// `CONFIRM_COPY`, or named in `HEADLESS_CONFIRMS` with the reason that it carries no heading at all. A
// fifth dialog written next month lands in neither and fails here.
//
// ⚠️ What this does NOT claim: that a heading and its body are semantically consistent. No test reads
// Japanese. What it pins is the two ways they came apart in practice — a heading borrowed from a
// control's label, and a dialog outside the table.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import i18next, { type i18n as I18n } from "i18next";
import { CONFIRM_COPY, HEADLESS_CONFIRMS } from "../settings/AdminSignInMethodsSection";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

/**
 * The screen's source with COMMENTS STRIPPED.
 *
 * ⚠️ Measured: the first version of this counted five dialogs because the doc comment beside the table
 * says the words `<ConfirmDialog`. Prose satisfying a token sweep is the failure this repository keeps
 * meeting — usually by making a route read as bounded; here it inflated a count instead, which fails
 * loudly rather than quietly, but the cause is the same and the fix is to read code as code.
 */
const SRC = readFileSync(
  resolve(import.meta.dirname, "../settings/AdminSignInMethodsSection.tsx"), "utf8",
)
  .split("\n")
  .map((l) => l.replace(/^\s*(?:\/\/|\*|\/\*|\{\/\*).*$/, ""))
  .join("\n");

let i18n: I18n;
beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({
    resources: { en: { translation: en }, ja: { translation: ja } },
    lng: "en", fallbackLng: "en", interpolation: { escapeValue: false },
  });
});

describe("#683: every confirmation on this screen is accounted for", () => {
  it("the number of dialogs matches the number the table explains", () => {
    // The count is the whole point. `>= 2` was the leg that let a third dialog go unnoticed, so this
    // asks for equality against what is actually rendered.
    const rendered = (SRC.match(/<ConfirmDialog\b/g) ?? []).length;
    // The stance switch renders ONE `<ConfirmDialog` for all four of its entries (the direction is a
    // prop), so entries and elements are not one-to-one. Counted as: the dialogs are the headed ones
    // plus the headless ones, and the headed ones all draw their title from the table.
    const headed = rendered - HEADLESS_CONFIRMS.length;
    // #822 added the fourth: the last-way-in confirmation, which starts on the SERVER (a 409 the write
    // already got) rather than before the request like the other three.
    // #960 added the fifth: the members-stranded confirmation — the SAME shape (a server-started 409)
    // but a DIFFERENT question, which is why it carries its own code and its own dialog.
    expect(headed, "a confirmation appeared that nothing here explains").toBe(5);
    // …and every title rendered in this file comes from the table or is a dialog's own dedicated key
    // never a control's label. Measured below; this leg only fixes the population.
    expect(Object.keys(CONFIRM_COPY).length, "the table lost an entry").toBe(7); // #960 added membersStranded
  });

  it("no confirmation is headed with a control's label", () => {
    // THE defect, stated directly. `secondFactorRequired` is the switch's row label; using it as a
    // heading is what produced "Require two-factor authentication" over the picker's own question.
    //
    // The labels are found rather than listed: anything this file passes as `ariaLabel` or renders as a
    // row title is a control's name, and a heading must not be one of them.
    const controlLabels = new Set(
      [...SRC.matchAll(/ariaLabel=\{t\("([^"]+)"\)\}/g)].map((m) => m[1]!),
    );
    expect(controlLabels.size, "no control labels were found — the search stopped matching")
      .toBeGreaterThan(2);

    for (const [id, said] of Object.entries(CONFIRM_COPY)) {
      expect(controlLabels.has(said.title), `${id} is headed with a control's label (${said.title})`)
        .toBe(false);
    }
  });

  it("the kind picker asks its own question, in both languages", async () => {
    // The specific dialog the reject named, read as a reader meets it: the heading and the closing
    // question, side by side. They must not be the switch's sentence, and they must not be identical
    // to each other's key (a heading that IS the body says nothing extra).
    for (const lng of ["en", "ja"] as const) {
      await i18n.changeLanguage(lng);
      const title = i18n.t(CONFIRM_COPY.kinds!.title);
      const asks = i18n.t(CONFIRM_COPY.kinds!.message);
      expect(title, `${lng}: the picker is still headed as the requirement switch`)
        .not.toBe(i18n.t("adminAuth.secondFactorRequired"));
      expect(title, `${lng}: the heading did not resolve`).not.toMatch(/^adminAuth\./);
      expect(asks, `${lng}: the question did not resolve`).not.toMatch(/^adminAuth\./);
      // The heading is the question without the interrogative — the same words, so a reader who read
      // the heading and a reader who read the last line were told the same thing.
      expect(asks.replace(/[?？]$/, ""), `${lng}: heading "${title}" vs question "${asks}"`)
        .toContain(title.replace(/[?？]$/, "").replace(/する$/, ""));
    }
  });
});

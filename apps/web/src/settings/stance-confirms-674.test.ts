// #674: a stance switch never writes straight from a click — in either direction.
//
// #652 shipped the question on the ON direction of the second-factor requirement, reasoning from the
// sign-out it causes. The reasoning was one-sided: OFF lowers the bar for the whole tenant and cannot be
// undone for anybody who signs in meanwhile. The SSO stance beside it asked in NEITHER direction, and it
// decides which doors exist at all — which is how one fix leaves its neighbour untouched (#432/#444).
//
// So the rule is written over the SWITCHES, not over the two that were wrong: every stance toggle on
// this screen routes through the question. A third stance added next year is covered by the same walk.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

const panel = readFileSync(resolve(import.meta.dirname, "AdminSignInMethodsSection.tsx"), "utf8");
const code = panel.split("\n").map((l) => l.replace(/^\s*(?:\/\/|\*|\/\*|\{\/\*).*$/, "")).join("\n");

/** Every `<Switch …>` on this screen that carries a stance testid, with its onChange body. */
function stanceSwitches(): Array<{ testId: string; onChange: string }> {
  const out: Array<{ testId: string; onChange: string }> = [];
  for (const m of code.matchAll(/<Switch\b[\s\S]*?\/>/g)) {
    const tag = m[0];
    const testId = /testId="([^"]+)"/.exec(tag)?.[1] ?? "";
    // The stance switches are the tenant-wide requirements. The per-method ones (platform login,
    // passwords) are a different act: they turn one door off, and the server refuses the last one.
    if (!/required/.test(testId)) continue;
    const at = tag.indexOf("onChange=");
    out.push({ testId, onChange: at < 0 ? "" : tag.slice(at) });
  }
  return out;
}

describe("#674: lowering the bar asks first, and so does raising it", () => {
  it("finds the stance switches at all", () => {
    // Without this the walk below passes vacuously the day the switches are renamed or extracted.
    const found = stanceSwitches().map((s) => s.testId).sort();
    expect(found, `the screen's stance switches :: ${found.join(", ")}`)
      .toEqual(["second-factor-required-toggle", "sso-required-toggle"]);
  });

  it("no stance switch writes from its own onChange", () => {
    for (const s of stanceSwitches()) {
      expect(/setConfirming\(/.test(s.onChange), `${s.testId} opens the question :: ${s.onChange.trim().slice(0, 120)}`).toBe(true);
      expect(/\.mutate\(|save[A-Z]/.test(s.onChange), `${s.testId} writes nothing itself`).toBe(false);
    }
  });

  it("both directions of both stances have something to say", () => {
    // Four sentences, and none of them may be "are you sure": a question that does not name the
    // consequence is a click with an extra step. Each is checked for a word about what CHANGES.
    const keys = [
      "secondFactorEnableConfirm", "secondFactorDisableConfirm",
      "ssoRequiredEnableConfirm", "ssoRequiredDisableConfirm",
    ];
    for (const [lang, loc] of [["en", en], ["ja", ja]] as const) {
      for (const k of keys) {
        const copy = (loc as unknown as { adminAuth: Record<string, string> }).adminAuth[k];
        expect(copy, `${lang}.adminAuth.${k} exists`).toBeTruthy();
        expect(copy!.length, `${lang}.${k} says more than a word`).toBeGreaterThan(30);
      }
    }
    // …and the four are distinct sentences, not one reused (which would tell a reader turning the
    // requirement OFF about the sign-out that happens when it goes ON).
    const distinct = new Set(keys.map((k) => (en as unknown as { adminAuth: Record<string, string> }).adminAuth[k]));
    expect(distinct.size, "four situations, four sentences").toBe(4);
  });
});

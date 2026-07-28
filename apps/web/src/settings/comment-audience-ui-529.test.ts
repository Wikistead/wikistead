// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { commentAudienceSummary } from "./SpaceMembersTab";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

// #529(honest audience UI): the toggles are one of THREE OR'd comment routes. Pinned
// 1. the effective summary CHANGES with each toggle and never loses the baseline;
// 2. the baseline copy names the editors-always route and the individual grants (with a zero form);
// 3. each toggle carries a DELTA in both positions, and the guests-OFF delta does not overclaim
// ("every guest") — an edit-link guest comments through their edit right (thefinding).
type Dict = Record<string, unknown>;
const sm = (loc: Dict) => (loc as { spaceMembers: Record<string, string> }).spaceMembers;
const tFor = (loc: Dict) => (k: string, o?: Record<string, unknown>) => {
  let s = sm(loc)[k.replace(/^spaceMembers\./, "")] ?? k;
  for (const [key, v] of Object.entries(o ?? {})) s = s.replace(`{{${key}}}`, String(v));
  return s;
};

describe("#529: the effective comment-audience summary", () => {
  for (const [name, loc] of [["en", en], ["ja", ja]] as const) {
    it(`${name}: toggles move the summary; the baseline never leaves it`, () => {
      const t = tFor(loc);
      const base = commentAudienceSummary(t, { grantCount: 2, members: false, guests: false });
      const withMembers = commentAudienceSummary(t, { grantCount: 2, members: true, guests: false });
      const withBoth = commentAudienceSummary(t, { grantCount: 2, members: true, guests: true });
      // baseline present in every state
      for (const s of [base, withMembers, withBoth]) {
        expect(s).toContain(sm(loc).commentSummaryEditors);
        expect(s).toContain(sm(loc).commentSummaryGrants.replace("{{count}}", "2"));
      }
      // members toggle adds exactly the members clause
      expect(base).not.toContain(sm(loc).commentSummaryMembers);
      expect(withMembers).toContain(sm(loc).commentSummaryMembers);
      // guests toggle adds exactly the guests clause
      expect(withMembers).not.toContain(sm(loc).commentSummaryGuests);
      expect(withBoth).toContain(sm(loc).commentSummaryGuests);
    });

    it(`${name}: zero grants uses the zero form and drops the grants clause`, () => {
      const t = tFor(loc);
      const s = commentAudienceSummary(t, { grantCount: 0, members: false, guests: false });
      expect(s).toContain(sm(loc).commentSummaryEditors);
      expect(s).not.toContain("0");
      expect(sm(loc).commentBaselineGrants_zero.length).toBeGreaterThan(0);
    });

    it(`${name}: the toggle deltas exist in both positions and guests-OFF does not overclaim`, () => {
      const d = sm(loc);
      for (const k of ["commentMembersOn", "commentMembersOff", "commentGuestsOn", "commentGuestsOff"]) {
        expect(d[k], `${k} exists`).toBeTruthy();
      }
      expect(d.commentMembersOn).not.toBe(d.commentMembersOff);
      expect(d.commentGuestsOn).not.toBe(d.commentGuestsOff);
      //an edit-link guest can still comment with both toggles off — the OFF copy must carry it.
      expect(d.commentGuestsOff.toLowerCase()).toMatch(/edit|編集/);
    });
  }

  it("the component renders the baseline OUTSIDE the toggles (always visible, testid pinned)", () => {
    const src = readFileSync(resolve(import.meta.dirname, "./SpaceMembersTab.tsx"), "utf8");
    expect(src).toContain('data-testid="comment-baseline"');
    expect(src).toContain('data-testid="comment-effective-summary"');
    expect(src.indexOf('data-testid="comment-baseline"'), "baseline sits above the toggle map").toBeLessThan(src.indexOf('comment-open-guests'));
  });
});

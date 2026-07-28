// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { commentAudienceSummary } from "./SpaceMembersTab";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

// #529(honest audience UI) as AMENDED by the #552 ruling: the built-in `commenter` role and
// its grant-count display are GONE — the baseline names only the editors-always route, and the
// summary is editors + whatever the two toggles add. The old pins that required the grants line are
// re-pinned IN REVERSE (their return would be drift, not restoration).
type Dict = Record<string, unknown>;
const sm = (loc: Dict) => (loc as { spaceMembers: Record<string, string> }).spaceMembers;
const tFor = (loc: Dict) => (k: string, o?: Record<string, unknown>) => {
  let s = sm(loc)[k.replace(/^spaceMembers\./, "")] ?? k;
  for (const [key, v] of Object.entries(o ?? {})) s = s.replace(`{{${key}}}`, String(v));
  return s;
};

describe("#529/#552: the effective comment-audience summary", () => {
  for (const [name, loc] of [["en", en], ["ja", ja]] as const) {
    it(`${name}: toggles move the summary; the editors baseline never leaves it`, () => {
      const t = tFor(loc);
      const base = commentAudienceSummary(t, { members: false, guests: false });
      const withMembers = commentAudienceSummary(t, { members: true, guests: false });
      const withBoth = commentAudienceSummary(t, { members: true, guests: true });
      for (const s of [base, withMembers, withBoth]) expect(s).toContain(sm(loc).commentSummaryEditors);
      expect(base).not.toContain(sm(loc).commentSummaryMembers);
      expect(withMembers).toContain(sm(loc).commentSummaryMembers);
      expect(withMembers).not.toContain(sm(loc).commentSummaryGuests);
      expect(withBoth).toContain(sm(loc).commentSummaryGuests);
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

    it(`${name}: #552 — the grants vocabulary is GONE (its return is drift)`, () => {
      const d = sm(loc);
      for (const k of ["commentBaselineGrants", "commentBaselineGrants_zero", "commentSummaryGrants"]) {
        expect(d[k], `${k} must stay deleted`).toBeUndefined();
      }
    });
  }

  it("#552: the baseline renders WITHOUT the grants line; the summary never grows a grants clause", () => {
    const src = readFileSync(resolve(import.meta.dirname, "./SpaceMembersTab.tsx"), "utf8");
    expect(src).toContain('data-testid="comment-baseline"'); // the editors-always box stays
    expect(src).not.toContain("comment-baseline-grants"); // #552: the count line must not come back
    expect(src).not.toContain("commenterGrants");
    expect(src).toContain('data-testid="comment-effective-summary"');
    expect(src.indexOf('data-testid="comment-baseline"'), "baseline sits above the toggle map").toBeLessThan(src.indexOf("comment-open-guests"));
  });

  it("#552: `comment` left the picker but NOT the ordering (API-made rows must not float to the top)", () => {
    const src = readFileSync(resolve(import.meta.dirname, "./SpaceMembersTab.tsx"), "utf8");
    expect(src).toMatch(/CAP_ORDER: PageRelation\[\] = \["view", "comment", "edit", "moderate", "manage"\]/);
    expect(src).toMatch(/GRANTABLE: PageRelation\[\] = \["view", "edit", "moderate", "manage"\]/);
  });
});

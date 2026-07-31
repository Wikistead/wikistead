// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { commentAudienceSummary } from "./SpaceMembersTab";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

// #529 (honest audience UI) as AMENDED by the #552 ruling: the built-in `commenter` role and
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
    // #553: the baseline VALUE changed — "people with edit rights" became "managers, moderators and
    // people granted comment" (edit no longer implies comment). The structural pin (a baseline that
    // never leaves the summary) is unchanged.
    it(`${name}: toggles move the summary; the always-on baseline never leaves it`, () => {
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
      // #553 / ADR-199 §5(i) FLIP (was): edit-link guests now ride the AUDIENCE — with the
      // toggle OFF no guest comments, so the OFF copy must NOT claim the edit-link exception any more.
      expect(d.commentGuestsOff).not.toMatch(/edit right|編集権/);
      // …and the ON copy covers every guest who can see the page (edit links included — the (i) ruling)
      expect(d.commentGuestsOn.toLowerCase()).toMatch(/edit|編集/);
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

  it("#552: `comment` left the picker but NOT the display (API-made rows must still render + sort)", () => {
    // #536 ①: the capability-power CAP_ORDER sort went with the split lists — the merged list sorts
    // by principal LABEL (capability-independent, so an API-made comment row cannot float to a bogus
    // indexOf(-1) position by construction). What must survive: the row still DISPLAYS as its noun
    // (CAP_NOUN keeps `comment`), and the picker still does not offer it (#552).
    const src = readFileSync(resolve(import.meta.dirname, "./SpaceMembersTab.tsx"), "utf8");
    expect(src).toMatch(/comment: "commenter"/); // CAP_NOUN still names an API-made comment row
    expect(src).toMatch(/GRANTABLE: PageRelation\[\] = \["view", "edit", "moderate", "manage"\]/);
    expect(src).toMatch(/\.sort\(\(x, y\) => x\.label\.localeCompare\(y\.label\)/); // label sort, not indexOf
  });
});

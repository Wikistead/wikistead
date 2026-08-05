import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { memberStatusKeys, memberMenuValues, passwordAction } from "./member-status";

// #614: the two pure decisions — which marks a row wears, and whether the ⋯ menu still offers a
// password entrance. Both sides of the menu split are pinned (→→), because the defect this
// descends from (#606) was an offered action that could only fail.

const src = readFileSync(resolve(import.meta.dirname, "MembersPage.tsx"), "utf8");

describe("memberStatusKeys (#614)", () => {
  it("an IdP-born member wears the origin mark alone", () => {
    expect(memberStatusKeys({ identity_source: "oidc", has_password: false, deactivated_at: null })).toEqual(["idp"]);
  });
  it("a pre-083 row (no identity_source on the wire) still reads as IdP-born", () => {
    expect(memberStatusKeys({})).toEqual(["idp"]);
  });
  it("an IdP member with a password added wears both — the three states stay distinguishable", () => {
    expect(memberStatusKeys({ identity_source: "oidc", has_password: true, deactivated_at: null })).toEqual(["idp", "password"]);
  });
  it("a password-born local user is ONE key, not a key repeated", () => {
    expect(memberStatusKeys({ identity_source: "local", has_password: true, deactivated_at: null })).toEqual(["local"]);
  });
  it("suspension rides along on any of them", () => {
    expect(memberStatusKeys({ identity_source: "oidc", has_password: false, deactivated_at: "2026-08-04T00:00:00Z" })).toEqual(["idp", "deactivated"]);
    expect(memberStatusKeys({ identity_source: "local", has_password: true, deactivated_at: "2026-08-04T00:00:00Z" })).toEqual(["local", "deactivated"]);
  });
});

describe("memberMenuValues (#614)", () => {
  // RE-AIMED by the review rejection: removing the item from a member who already had a password was the
  // first answer, and it cost the admin the only way to hand somebody a reset link without email — the
  // person #605's break-glass exists for. The item stays for everyone; what changes is what it MEANS.
  it("the password item is offered whatever state the member is in", () => {
    // The #614 ruling, unchanged: `password` is present in every row. #626 adds a SECOND item beside it
    // for a member who has one — an addition, never the replacement this test was written to forbid.
    for (const m of [{ has_password: false }, { has_password: true }, {}]) {
      expect(memberMenuValues(m), JSON.stringify(m)).toContain("password");
    }
  });

  it("#626: taking the entrance back is an EXTRA item, and only where the server would allow it", () => {
    // no password → nothing to remove
    expect(memberMenuValues({ has_password: false })).toEqual(["password", "erase", "remove"]);
    // a federated member with a password → both errands
    expect(memberMenuValues({ has_password: true, identity_source: "oidc" }))
      .toEqual(["password", "passwordRemove", "erase", "remove"]);
    // …but a password-born member has no other way in, and the server refuses with `last_way_in`. An
    // action that cannot succeed is the defect #596/#606 are about, so it is not offered.
    expect(memberMenuValues({ has_password: true, identity_source: "local" }))
      .toEqual(["password", "erase", "remove"]);
  });

  it("and it is a DIFFERENT errand depending on the state", () => {
    expect(passwordAction({ has_password: false })).toBe("grant");
    expect(passwordAction({})).toBe("grant");
    expect(passwordAction({ has_password: true })).toBe("reissue");
  });

  it("the page picks its words from that, rather than from one sentence for both", () => {
    expect(src, "the label branches").toMatch(/passwordAction\(m\) === "reissue" \? t\("members\.reissuePassword"\)/);
    expect(src, "and so does the toast").toMatch(/members\.reissuePasswordDone/);
  });
});

// The page must actually consume both helpers — a pure pin over an unwired function proves nothing
// (the vacuous-pin lesson). Source-shape check, not a render: the wiring is one line each.
describe("MembersPage wiring (#614)", () => {
  it("the row draws the status icon group", () => {
    expect(src).toMatch(/<MemberStatusIcons member=\{m\}/);
  });
  it("the ⋯ menu filters through memberMenuValues", () => {
    expect(src).toMatch(/\.filter\(\(i\) => memberMenuValues\(m\)/);
  });
  it("a suspended row dims its NAME, not the whole row", () => {
    // #614 (review rejection, measured): dimming the <tr> took the status marks down with it — 2.22:1 in
    // light, under the 3:1 a non-text UI element needs — so the evidence that a row is suspended was the
    // hardest thing on it to see. The marks and the actions keep full opacity; the name carries the mute.
    expect(src, "the name is what dims").toMatch(/data-testid="member-name"[\s\S]{0,80}opacity: dimmed/);
    expect(src, "and the row itself no longer carries an opacity").not.toMatch(/<tr[\s\S]{0,200}opacity:/);
  });
});

// Every status key the helper can emit has words in BOTH locales — a mark whose hover says a raw
// i18n key is worse than no mark.
describe("status strings exist (#614)", () => {
  const keys = new Set<string>();
  for (const m of [
    {}, { identity_source: "local" as const, has_password: true },
    { has_password: true }, { deactivated_at: "x" },
  ]) for (const k of memberStatusKeys(m)) keys.add(k);
  for (const locale of ["en", "ja"]) {
    it(`${locale} covers all emitted keys`, () => {
      const dict = JSON.parse(readFileSync(resolve(import.meta.dirname, `../i18n/locales/${locale}.json`), "utf8"));
      for (const k of keys) {
        expect(dict.members?.status?.[k], `members.status.${k} in ${locale}`).toBeTruthy();
      }
    });
  }
});

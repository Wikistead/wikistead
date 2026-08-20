import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { memberStatusKeys, memberMenuValues, passwordAction } from "./member-status";

// #614: the two pure decisions — which marks a row wears, and whether the ⋯ menu still offers a
// password entrance. Both sides of the menu split are pinned (password present→absent AND
// absent→present), because the defect this
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
    // no password → nothing to remove (#627 adds `suspend` to an active member, which is not this claim)
    expect(memberMenuValues({ has_password: false })).not.toContain("passwordRemove");
    // a federated member with a password → both errands
    expect(memberMenuValues({ has_password: true, identity_source: "oidc" })).toContain("passwordRemove");
    // …but a password-born member has no other way in, and the server refuses with `last_way_in`. An
    // action that cannot succeed is the defect #596/#606 are about, so it is not offered.
    expect(memberMenuValues({ has_password: true, identity_source: "local" })).not.toContain("passwordRemove");
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

describe("#627: the suspension items", () => {
  // One of the two, never both — and only where the console owns the decision.
  it("an active member can be suspended", () => {
    expect(memberMenuValues({ has_password: false })).toContain("suspend");
    expect(memberMenuValues({ has_password: false })).not.toContain("reactivate");
  });

  it("an admin's suspension is the console's to undo", () => {
    const m = { has_password: false, deactivated_at: "2026-01-01T00:00:00Z", deactivation_reason: "admin" as const };
    expect(memberMenuValues(m)).toContain("reactivate");
    expect(memberMenuValues(m), "and it is not offered twice").not.toContain("suspend");
  });

  it("but a directory removal and a plan freeze are not", () => {
    // ruling 4: a member SCIM removed comes back through SCIM, or a tenant could restore somebody their
    // IdP dropped — admin grant and all — from inside the product. ruling 5: a freeze is billing's.
    for (const reason of ["scim", "downgrade_freeze"] as const) {
      const m = { has_password: false, deactivated_at: "2026-01-01T00:00:00Z", deactivation_reason: reason };
      expect(memberMenuValues(m), reason).not.toContain("reactivate");
      expect(memberMenuValues(m), reason).not.toContain("suspend");
    }
  });
});

describe("#644: the factor reset is offered only to somebody who holds one", () => {
  // The reset SUCCEEDS on a member with no factors: it deletes nothing and answers 200. So an item
  // shown to everybody is not the always-failing button of #596/#606 — it is worse. It reports having
  // helped a person who is still locked out for some other reason, and the admin stops looking.
  it("a member with a confirmed factor is offered it", () => {
    expect(memberMenuValues({ has_password: false, has_factor: true })).toContain("factorReset");
  });

  it("a member with none is not", () => {
    expect(memberMenuValues({ has_password: false, has_factor: false })).not.toContain("factorReset");
    // Absent, not false: a list endpoint that predates the field must not light the item up.
    expect(memberMenuValues({ has_password: false })).not.toContain("factorReset");
  });

  it("it does not displace the password items", () => {
    // #614's lesson, in its own shape: an item added here took another away, and the one it took was
    // the last route into a tenant with no working mail. A member can hold both a password and a
    // factor, and both errands stay available.
    const m = { has_password: true, identity_source: "oidc" as const, has_factor: true };
    expect(memberMenuValues(m)).toEqual(
      expect.arrayContaining(["password", "passwordRemove", "factorReset"]));
  });

  it("a suspended member still shows it, because a reset is not a way in", () => {
    // Clearing a factor grants nothing on its own — sign-in stays shut while the suspension holds. The
    // useful case is preparing somebody's return before reactivating them.
    const m = { has_password: false, has_factor: true, deactivated_at: "2026-01-01T00:00:00Z", deactivation_reason: "admin" as const };
    expect(memberMenuValues(m)).toContain("factorReset");
  });
});

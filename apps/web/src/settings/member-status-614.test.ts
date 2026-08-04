import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { memberStatusKeys, memberMenuValues } from "./member-status";

// #614: the two pure decisions — which marks a row wears, and whether the ⋯ menu still offers a
// password entrance. Both sides of the menu split are pinned (→→), because the defect this
// descends from (#606) was an offered action that could only fail.

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
  it("no password yet → the entrance is offered (the old behaviour survives)", () => {
    expect(memberMenuValues({ has_password: false })).toEqual(["password", "erase", "remove"]);
    expect(memberMenuValues({})).toEqual(["password", "erase", "remove"]);
  });
  it("already has one → the item that could only fail is gone; everything else stays", () => {
    expect(memberMenuValues({ has_password: true })).toEqual(["erase", "remove"]);
  });
});

// The page must actually consume both helpers — a pure pin over an unwired function proves nothing
// (the vacuous-pin lesson). Source-shape check, not a render: the wiring is one line each.
describe("MembersPage wiring (#614)", () => {
  const src = readFileSync(resolve(import.meta.dirname, "MembersPage.tsx"), "utf8");
  it("the row draws the status icon group", () => {
    expect(src).toMatch(/<MemberStatusIcons member=\{m\}/);
  });
  it("the ⋯ menu filters through memberMenuValues", () => {
    expect(src).toMatch(/\.filter\(\(i\) => memberMenuValues\(m\)/);
  });
  it("a suspended row is dimmed", () => {
    expect(src).toMatch(/opacity: m\.deactivated_at != null \? 0\.55/);
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

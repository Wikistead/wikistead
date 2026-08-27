// #866 (review rejection 2026-08-27): the member screen answered every 409 with the FLOOR's sentence.
//
// The guard this ticket added refuses a demotion that leaves administrators behind but leaves nobody
// who can sign in. Its 409 (`login_lockout`) came out reading "Cannot change the last admin." — which
// an operator looking at two administrators reads as a bug, and a refusal that reads like a bug is the
// one somebody removes in good faith. That is the exact failure ADR-251 §3.7 gave `demoting` its own
// closing shape to avoid, undone one layer above.
//
// Measured as VALUES rather than through the screen: what broke was a mapping, and a mapping is a
// function. The screen's own use of it is pinned separately below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ApiError } from "../data/apiClient";
import { roleChangeRefusalKey } from "./role-change-refusal";

const SRC_ROOT = resolve(import.meta.dirname, "..");
const refuse = (code: string, status = 409) => Object.assign(new ApiError(status, "/members/x", code), { code });

describe("#866 each refusal of a member write earns its own sentence", () => {
  it("the four 409s do not share one answer", () => {
    const keys = ["last_admin", "last_direct_admin", "login_lockout", "confirm_required"]
      .map((c) => roleChangeRefusalKey(refuse(c)));
    expect(new Set(keys).size, `four refusals collapsed onto ${keys.length - new Set(keys).size + 1} sentence(s): ${keys.join(", ")}`).toBe(4);
  });

  it("the lockout does NOT wear the floor's words", () => {
    // The whole defect in one assertion: administrators remain, so "the last admin" is a false
    // statement about the world, and it sends the reader off to appoint one instead of giving one a
    // way in.
    expect(roleChangeRefusalKey(refuse("login_lockout"))).not.toBe("members.lastAdmin");
    expect(roleChangeRefusalKey(refuse("login_lockout"))).toBe("members.lockoutRefused");
  });

  it("a 409 nobody has written words for falls back to the GENERIC failure, not to the floor", () => {
    // The fallback is where the bug lived: `status === 409` caught everything the table had not met.
    for (const code of ["seat_limit", "self_suspend", "not_your_suspension", "some_code_from_2027"]) {
      expect(roleChangeRefusalKey(refuse(code)), `an unmapped ${code} claims to be about the last admin`).toBe("toast.actionFailed");
    }
  });

  it("a suspended member's refusal says so, and a non-API failure stays generic", () => {
    expect(roleChangeRefusalKey(refuse("member_suspended"))).toBe("members.suspendedRoleChange");
    expect(roleChangeRefusalKey(new TypeError("network"))).toBe("toast.actionFailed");
    expect(roleChangeRefusalKey(undefined)).toBe("toast.actionFailed");
  });

  it("every sentence it names exists, in both locales, and is not the English twice", () => {
    const en = JSON.parse(readFileSync(resolve(SRC_ROOT, "i18n/locales/en.json"), "utf8")) as Record<string, Record<string, string>>;
    const ja = JSON.parse(readFileSync(resolve(SRC_ROOT, "i18n/locales/ja.json"), "utf8")) as Record<string, Record<string, string>>;
    const codes = ["last_admin", "last_direct_admin", "login_lockout", "confirm_required", "member_suspended", "whatever"];
    for (const code of codes) {
      const [ns, key] = roleChangeRefusalKey(refuse(code)).split(".");
      expect(en[ns!]?.[key!], `en is missing ${ns}.${key}`).toBeTruthy();
      expect(ja[ns!]?.[key!], `ja is missing ${ns}.${key}`).toBeTruthy();
      expect(ja[ns!]![key!], `ja.${ns}.${key} is still the English string`).not.toBe(en[ns!]![key!]);
    }
  });

  it("the lockout sentence tells the reader what to do about a KEY, not about appointing somebody", () => {
    // ADR-251's refusals say ADMINISTRATOR deliberately, and the remedy for this one is a way IN.
    // Without this the sentence drifts back towards the floor's advice, which is what made the two
    // indistinguishable in the first place.
    const en = JSON.parse(readFileSync(resolve(SRC_ROOT, "i18n/locales/en.json"), "utf8")) as Record<string, Record<string, string>>;
    expect(en.members!.lockoutRefused.toLowerCase()).toContain("sign in");
    expect(en.members!.lockoutRefused.toLowerCase()).toContain("way in");
  });

  it("the screen reports it as a TOAST, and no longer routes a 409 into the inline paragraph", () => {
    // #866 (user ruling): every other surface answers this family through `notify.error` — the
    // sign-in methods screen answers the SAME `login_lockout` that way. This screen was the one that
    // answered in a crimson paragraph above a list nobody is looking at while operating a row.
    const src = readFileSync(resolve(SRC_ROOT, "settings/MembersPage.tsx"), "utf8");
    const guarded = src.slice(src.indexOf("const guarded ="), src.indexOf("const groupNames ="));
    expect(guarded, "the guard's catch does not report through notify").toContain("notify.error(t(roleChangeRefusalKey(e)))");
    expect(guarded, "a 409 is still being spelt out inline instead of asking the table").not.toMatch(/status === 409/);
    expect(guarded, "the refusal still writes into the inline error paragraph").not.toMatch(/setError\(\s*\n?\s*e instanceof/);
  });
});

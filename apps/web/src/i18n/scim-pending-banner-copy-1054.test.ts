// #1054 / ADR-275 rev3 §4: the console's own copy holds the SAME non-disclosure line the out-of-band
// notice (#1051) does — "pending", never which floor or how many administrators remain. This reads
// the shipped locale files directly (the way #1051's own builder pin judges rendered text), so a
// future edit that slips a floor name or a count into the JSON is caught the same way.
import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

const LOCALES = { en, ja } as const;

describe("#1054: the pending banner/status copy discloses no state", () => {
  for (const [locale, catalog] of Object.entries(LOCALES) as [string, typeof en][]) {
    it(`(${locale}) names neither floor, nor an admin count`, () => {
      const whole = [
        catalog.members.status.pending,
        catalog.members.pendingBannerTitle,
        catalog.members.pendingBannerBody,
      ].join("\n");
      for (const tell of ["last_admin", "last admin", "login_lockout", "login lockout"]) {
        expect(whole.toLowerCase(), `"${tell}" would name which floor`).not.toContain(tell.toLowerCase());
      }
      expect(whole, "a bare small integer would suggest a headcount").not.toMatch(/\b\d+\s*(admin|administrator|管理者)/i);
    });

    it(`(${locale}) the banner names only the two shipped recovery tools`, () => {
      expect(catalog.members.pendingBannerBody).toContain("pnpm tenant:login-methods");
      expect(catalog.members.pendingBannerBody).toContain("pnpm tenant:local-admin");
    });
  }

  it("en and ja are actually different prose (the per-locale detector above is not vacuous)", () => {
    expect(en.members.pendingBannerBody).not.toBe(ja.members.pendingBannerBody);
    expect(en.members.status.pending).not.toBe(ja.members.status.pending);
  });
});

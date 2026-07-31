import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

// #529 review rejection: the authz landed (a space-wide `commenter` capability alongside the audience
// toggles) but this paragraph still said a per-member comment grant "is set on each page" — written
// before the capability existed. A reader takes that at face value and misses the commenter selector
// sitting a few rows above it, and, worse, expects the toggles to be the whole story: turn them off and
// someone with the commenter role can still comment. ADR-193 called for an HONEST comment-audience UI,
// so the copy has to name both paths and say they are independent.
const bodies = { en: en.spaceMembers.commentAudienceBody, ja: ja.spaceMembers.commentAudienceBody };

describe("#529: the comment-audience copy describes both paths", () => {
  for (const [loc, body] of Object.entries(bodies)) {
    // #553 / ADR-199 §2 rev5 re-aim: the built-in commenter ROLE is gone (#552) and the word
    // "commenter" appears in no UI — the per-person path is now an explicit comment GRANT, and the
    // copy must name that path without resurrecting the dead role name.
    it(`${loc}: names the explicit comment grant as the per-person path (not the dead commenter role)`, () => {
      expect(body.toLowerCase()).toContain("comment");
      expect(body.toLowerCase()).not.toContain("commenter");
    });

    it(`${loc}: says the toggles and the role are independent`, () => {
      const saysIndependent = loc === "en"
        ? /independent|does not take/i.test(body)
        : /独立|オフにしても/.test(body);
      expect(saysIndependent, `the reader must not expect the toggles to revoke a commenter: ${body}`).toBe(true);
    });

    it(`${loc}: no longer claims per-member grants live only on each page`, () => {
      const oldClaim = loc === "en" ? /grant is set on each page/i : /個別のコメント付与は各ページで設定/;
      expect(oldClaim.test(body)).toBe(false);
    });
  }
});

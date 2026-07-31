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
    // "commenter" appears on no GRANT surface (a lone comment row still wears it as a badge) — the
    // per-person path is now an explicit comment GRANT, and the
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

// #553 / — the THIRD time this paragraph went stale after a model change, so this pin
// stops describing wording and starts describing the product: the copy tells the reader how to give
// one person comment, and the route it names has to be one they can actually walk. The space picker
// offers built-in nouns only (GRANTABLE: view / edit / moderate / manage — comment left with #552), so
// "grant comment in the access list above" was an instruction that cannot be followed. The page
// permissions dialog DOES offer comment, and a custom role including comment is the space-wide route.
describe("#553: the per-person route the copy names actually exists", () => {
  // mirrored from SpaceMembersTab (GRANTABLE) — if someone puts comment back in the picker, this
  // constant moves with it and the pin below relaxes on purpose.
  const SPACE_PICKER_CAPS = ["view", "edit", "moderate", "manage"];

  for (const [loc, body] of Object.entries(bodies)) {
    it(`${loc}: does not send the reader to a space picker that has no comment in it`, () => {
      if (SPACE_PICKER_CAPS.includes("comment")) return // the instruction became true again
      const claimsPicker = loc === "en"
        ? /grant comment in the access list above|comment in the (access )?list above/i.test(body)
        : /上のアクセス一覧で\s*comment\s*を付与/.test(body)
      expect(claimsPicker, `the picker offers ${SPACE_PICKER_CAPS.join("/")} — this sentence cannot be followed: ${body}`).toBe(false)
    });

    it(`${loc}: names the routes that DO exist (a custom role including comment, or the page dialog)`, () => {
      const namesRole = loc === "en" ? /custom role/i.test(body) : /カスタムロール/.test(body)
      const namesPage = loc === "en" ? /page's permissions|single page/i.test(body) : /ページの権限|そのページ/.test(body)
      expect(namesRole && namesPage, `both real routes must be findable from this text: ${body}`).toBe(true)
    });
  }
});

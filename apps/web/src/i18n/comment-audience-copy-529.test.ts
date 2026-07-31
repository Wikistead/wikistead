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

// #553/— the paragraph has gone stale after a model change three times, and the fix for
// the third staleness was itself wrong ("the picker above grants built-in roles only" — it offers
// custom roles too, which is exactly the route the text recommends). So the pin stops paraphrasing the
// UI and READS it: the real GRANTABLE list, imported, decides whether a sentence about granting
// comment from that picker can be true.
import { GRANTABLE } from "../settings/SpaceMembersTab";

describe("#553: the per-person route the copy names actually exists", () => {
  const grantable = GRANTABLE as readonly string[];

  it("comment is not a built-in the picker can grant — the premise of the advice", () => {
    expect(grantable).not.toContain("comment");
  });

  for (const [loc, body] of Object.entries(bodies)) {
    it(`${loc}: does not claim comment can be granted from the picker directly`, () => {
      if (grantable.includes("comment")) return // the instruction became true again
      const claimsDirect = loc === "en"
        ? /grant comment in the access list above|grant comment from the (access )?list/i.test(body)
        : /上のアクセス一覧で\s*comment\s*を付与/.test(body)
      expect(claimsDirect, `the picker offers ${grantable.join("/")} — this sentence cannot be followed: ${body}`).toBe(false)
    });

    it(`${loc}: names the routes that DO exist (a custom role including comment, or the page dialog)`, () => {
      const namesRole = loc === "en" ? /custom role/i.test(body) : /カスタムロール/.test(body)
      const namesPage = loc === "en" ? /page's permissions|single page|one page/i.test(body) : /ページの権限|ページ単位/.test(body)
      expect(namesRole && namesPage, `both real routes must be findable from this text: ${body}`).toBe(true)
    });

    it(`${loc}: if it lists the picker's built-ins, the list matches the code`, () => {
      // the other way this paragraph rots: naming the nouns and then someone changes GRANTABLE
      const mentioned = grantable.filter((c) => new RegExp(c === "view" ? "viewer" : c === "edit" ? "editor" : c === "moderate" ? "moderator" : "manager", "i").test(body))
      if (mentioned.length === 0) return // it does not enumerate them — nothing to keep in sync
      expect(mentioned.length, `the text enumerates only part of ${grantable.join("/")}: ${body}`).toBe(grantable.length)
    });
  }
});

// #553 re-review: the ja text said the built-in roles "cannot grant comment" while a sentence four
// lines below it — in the same panel, always on screen together — said the editor granted here DOES
// carry comment. The en had "on its own", which makes both true; the ja had dropped it. Copy in two
// languages drifts when only one is edited, so this checks the pair against each other rather than
// against a remembered wording.
describe("#553: the panel does not contradict itself about editor", () => {
  const bodyOf = (loc: "en" | "ja") => (loc === "en" ? en : ja).spaceMembers;

  for (const loc of ["en", "ja"] as const) {
    it(`${loc}: if the text says the built-ins cannot grant comment, it says "on its own"`, () => {
      const s = bodyOf(loc);
      const blanket = loc === "en"
        ? /cannot grant comment(?!\s+on its own)/i.test(s.commentAudienceBody)
        : /comment\s*を付与できません/.test(s.commentAudienceBody);
      // the sentence right below it, which the reader sees at the same time
      const editorCarriesComment = loc === "en"
        ? /Editors granted here carry an explicit comment grant/i.test(s.commentBaselineEditors)
        : /editor には comment も明示的に付与されます/.test(s.commentBaselineEditors);
      expect(blanket && editorCarriesComment,
        `these two are on screen together and disagree:\n  ${s.commentAudienceBody}\n  ${s.commentBaselineEditors}`).toBe(false);
    });
  }
});

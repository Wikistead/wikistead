import { describe, it, expect } from "vitest";
import ja from "./locales/ja.json";
import en from "./locales/en.json";

// #468: the vendor-access (Access Transparency) blurb is read by tenant admins, not by operators
// is vendor jargon that says nothing to them. The Japanese copy now explains the
// thing (emergency-only, exceptional access, tamper-evident chain); the English keeps the term of
// art but leads with the plain word so both audiences land in the same place.
describe("#468: the vendor-access blurb avoids untranslated jargon", () => {
  it("the Japanese copy drops ブレークグラス and says what it actually is", () => {
    const body = ja.transparency.body;
    expect(body).not.toContain("ブレークグラス");
    expect(body).toContain("緊急時");
    expect(body).toContain("改ざん");
  });

  it("the English copy leads with the plain word, keeping the term of art as a gloss", () => {
    const body = en.transparency.body;
    expect(body.toLowerCase()).toContain("emergency");
    expect(body.toLowerCase()).toContain("break-glass"); // still findable by operators/auditors
  });

  it("no user-facing Japanese string anywhere still says ブレークグラス", () => {
    expect(JSON.stringify(ja)).not.toContain("ブレークグラス");
  });
});

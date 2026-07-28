// @vitest-environment node
import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

// #546: the editor-setup banner is a PERMANENT entry point, and it opened with "New:" — a claim that
// means nothing to a new user and turns false by simple passage of time. The copy states what the
// banner does, without a freshness badge; this pin keeps the prefix from creeping back.
describe("#546: the setup banner does not call itself new", () => {
  it("en carries no freshness prefix", () => {
    const s = (en as { onboarding: { bannerText: string } }).onboarding.bannerText;
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toMatch(/^new\s*[:：]/i);
  });
  it("ja carries no freshness prefix", () => {
    const s = (ja as { onboarding: { bannerText: string } }).onboarding.bannerText;
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toMatch(/^新機能\s*[:：]/);
  });
});

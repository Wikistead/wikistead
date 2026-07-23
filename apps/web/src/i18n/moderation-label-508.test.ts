import { describe, it, expect } from "vitest";
import ja from "./locales/ja.json";
import en from "./locales/en.json";

// #508: the same "Moderation" label sat on two DIFFERENT features on two different layers — the
// tenant /admin tab (abuse POLICY settings, tenant-admin) and the space-settings tab (the patrol
// QUEUE, space moderator) — and a real user read them as one thing. The space side now follows its
// design name, Patrol (#326 / ADR-142); the tenant side keeps Moderation. This pin is about the
// collision, not the exact words: the two labels must never converge again, in either locale.
describe("#508: the tenant and space moderation tabs carry distinct labels", () => {
  it("English: /admin and space settings do not share a label", () => {
    expect(en.adminNav.moderation).not.toBe(en.spaceSettings.moderation);
  });

  it("Japanese: /admin and space settings do not share a label", () => {
    expect(ja.adminNav.moderation).not.toBe(ja.spaceSettings.moderation);
  });

  it("the space queue heading matches the space tab's naming, not the tenant tab's", () => {
    // the heading inside the tab (moderation.title) should read as the queue of the SPACE feature —
    // it must not re-introduce the tenant tab's bare label as its lead word
    expect(en.moderation.title.startsWith(en.adminNav.moderation)).toBe(false);
    expect(ja.moderation.title.startsWith(ja.adminNav.moderation)).toBe(false);
  });
});

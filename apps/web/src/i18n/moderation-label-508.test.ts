import { describe, it, expect } from "vitest";
import ja from "./locales/ja.json";
import en from "./locales/en.json";

// #508 (user ruling 2026-07-24,): the tenant /admin tab (abuse POLICY settings) and the
// space-settings tab (the patrol QUEUE) may BOTH read "Moderation" — they sit on different layers
// (tenant vs space), so the shared label carries little risk, and the earlier "Patrol / " rename
// did not land the intended feel. This reverts to Moderation on the space side. The internal name
// (patrol / patrolled testids, ADR-142) is unchanged — this is display text only. The pin now guards
// the INTENDED strings (a future accidental edit that re-renames the space side is caught), NOT a
// non-collision the ruling deliberately allows.
describe("#508: the space and tenant moderation labels are the intended (shared) 'Moderation'", () => {
  it("English: the space-settings tab reads Moderation, its queue heading Moderation queue", () => {
    expect(en.spaceSettings.moderation).toBe("Moderation");
    expect(en.moderation.title).toBe("Moderation queue");
    expect(en.adminNav.moderation).toBe("Moderation"); // the /admin tab is unchanged
  });

  it("Japanese: the space-settings tab reads モデレーション, its queue heading モデレーションキュー", () => {
    expect(ja.spaceSettings.moderation).toBe("モデレーション");
    expect(ja.moderation.title).toBe("モデレーションキュー");
    expect(ja.adminNav.moderation).toBe("モデレーション"); // the /admin tab is unchanged
  });
});

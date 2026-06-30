// #109 / ADR-072 frontend disclosure rule (pure). authz loss never shows an upgrade hint (even to
// admins — existence hiding); entitlement loss shows it only to owner/admin.
import { describe, it, expect } from "vitest";
import { shouldShowUpgradeAffordance } from "./upgrade-affordance";

describe("shouldShowUpgradeAffordance (#109 / ADR-072)", () => {
  it("authz loss NEVER shows the affordance (no existence leak), regardless of role", () => {
    for (const role of ["owner", "admin", "member", "guest"] as const) {
      expect(shouldShowUpgradeAffordance("authz", role)).toBe(false);
    }
  });

  it("entitlement loss shows the affordance ONLY to owner/admin", () => {
    expect(shouldShowUpgradeAffordance("entitlement", "owner")).toBe(true);
    expect(shouldShowUpgradeAffordance("entitlement", "admin")).toBe(true);
    expect(shouldShowUpgradeAffordance("entitlement", "member")).toBe(false);
    expect(shouldShowUpgradeAffordance("entitlement", "guest")).toBe(false);
  });
});

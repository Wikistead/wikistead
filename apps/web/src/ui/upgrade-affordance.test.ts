// #109 / ADR-072 frontend disclosure rule (pure). authz loss never shows an upgrade hint (even to
// admins — existence hiding); entitlement loss shows it only to owner/admin.
import { describe, it, expect } from "vitest";
import { shouldShowUpgradeAffordance, disclosureKindFromError, versionedCacheKey } from "./upgrade-affordance";

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

describe("disclosureKindFromError (#109 / ADR-072 — evaluation-order keystone)", () => {
  it("404 is ALWAYS authz (existence-hiding), even if a stray entitlement marker is present", () => {
    expect(disclosureKindFromError({ status: 404 })).toBe("authz");
    // a 404 must never be re-classified as entitlement (that would leak existence via an affordance)
    expect(disclosureKindFromError({ status: 404, code: "api_not_entitled", upgrade: true })).toBe("authz");
  });

  it("403 is entitlement ONLY with a positive marker; a bare 403 falls to authz (no affordance)", () => {
    expect(disclosureKindFromError({ status: 403, upgrade: true })).toBe("entitlement");
    expect(disclosureKindFromError({ status: 403, code: "api_not_entitled" })).toBe("entitlement");
    expect(disclosureKindFromError({ status: 403, code: "upgrade_required" })).toBe("entitlement");
    expect(disclosureKindFromError({ status: 403 })).toBe("authz"); // plain authorization denial
    expect(disclosureKindFromError({ status: 403, code: "read_only_api_key" })).toBe("authz"); // non-entitlement code
  });

  it("reads statusCode as well as status (ApiError uses `status`, raw bodies use `statusCode`)", () => {
    expect(disclosureKindFromError({ statusCode: 403, upgrade: true })).toBe("entitlement");
    expect(disclosureKindFromError({ statusCode: 404 })).toBe("authz");
  });

  it("a non-denial (network/5xx/undefined) is not a disclosure case", () => {
    expect(disclosureKindFromError({ status: 500 })).toBeNull();
    expect(disclosureKindFromError({})).toBeNull();
  });

  it("end-to-end keystone: an authz 404 can never surface an affordance for any role", () => {
    const kind = disclosureKindFromError({ status: 404 });
    for (const role of ["owner", "admin", "member", "guest"] as const) {
      expect(kind && shouldShowUpgradeAffordance(kind, role)).toBe(false);
    }
  });
});

describe("versionedCacheKey (#109 / ADR-072 monotonic deny + ADR-063 versions)", () => {
  it("is stable for identical inputs", () => {
    expect(versionedCacheKey("embed:x", "user:a", 1, 1)).toBe(versionedCacheKey("embed:x", "user:a", 1, 1));
  });
  it("changes when plan OR policy version bumps (no stale hit after downgrade/revocation)", () => {
    const base = versionedCacheKey("embed:x", "user:a", 1, 1);
    expect(versionedCacheKey("embed:x", "user:a", 2, 1)).not.toBe(base); // plan downgrade
    expect(versionedCacheKey("embed:x", "user:a", 1, 2)).not.toBe(base); // policy bump
  });
  it("never collides across principals (no cross-principal cache sharing)", () => {
    expect(versionedCacheKey("embed:x", "user:a", 1, 1)).not.toBe(versionedCacheKey("embed:x", "user:b", 1, 1));
  });
});

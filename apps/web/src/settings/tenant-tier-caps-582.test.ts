import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tenantTierCaps, TENANT_TIER_CAPS } from "./role-nouns";
import { roleOptions } from "./tenant-role-rows";

// #582 ① (review rejection): the tier options said nothing, so `member` and `admin` were the only role
// names on the screen that could not explain themselves. They can now — but `member`'s answer is
// configuration, not structure, and this pins the difference rather than the strings.

describe("#582 ①: a tier says what it confers HERE, or says nothing", () => {
  it("admin is structural: the same measured list regardless of tenant switches", () => {
    expect(tenantTierCaps(undefined).admin).toEqual(TENANT_TIER_CAPS.admin);
    expect(tenantTierCaps({ createSpaces: false, issueApiKeys: false }).admin).toEqual(TENANT_TIER_CAPS.admin);
  });

  it("member follows the tenant's OWN switches, both ways", () => {
    expect(tenantTierCaps({ createSpaces: true, issueApiKeys: false }).member).toEqual(["createSpaces"]);
    expect(tenantTierCaps({ createSpaces: false, issueApiKeys: true }).member).toEqual(["issueApiKeys"]);
    expect(tenantTierCaps({ createSpaces: true, issueApiKeys: true }).member).toEqual(["createSpaces", "issueApiKeys"]);
    // the case a static table gets wrong: a tenant that switched both off
    expect(tenantTierCaps({ createSpaces: false, issueApiKeys: false }).member).toEqual([]);
  });

  it("without the defaults, member says NOTHING rather than repeating a default", () => {
    // undefined, not [] — "nothing to say" and "confers nothing" are different claims, and only the
    // second one draws a panel
    expect(tenantTierCaps(undefined).member).toBeUndefined();
  });

  it("the picker carries those lists onto the options", () => {
    const withCaps = roleOptions([], tenantTierCaps({ createSpaces: true, issueApiKeys: false }));
    expect(withCaps.find((o) => o.value === "tier:admin")?.roleCapabilities).toEqual(TENANT_TIER_CAPS.admin);
    expect(withCaps.find((o) => o.value === "tier:member")?.roleCapabilities).toEqual(["createSpaces"]);

    const bare = roleOptions([]);
    expect(bare.find((o) => o.value === "tier:member")?.roleCapabilities, "no source, no claim").toBeUndefined();
    expect(bare.find((o) => o.value === "tier:admin")?.roleCapabilities, "same for admin when nothing is passed").toBeUndefined();
  });

  it("the tenant screen actually passes the live defaults (an unwired resolver proves nothing)", () => {
    const src = readFileSync(resolve(import.meta.dirname, "MembersPage.tsx"), "utf8");
    expect(src).toMatch(/tenantTierCaps\(tierDefaults\.data\?\.member\)/);
    expect(src, "and every picker on the screen gets them").not.toMatch(/roleOptions\(roles\.data\?\.custom \?\? \[\]\)/);
  });
});

// #536 (user re-ruling): the Roles tab shows ONE roles list — built-in and custom, tenant- and
// resource-scope, side by side — and creation is one flow with no scope selector (scope derives from
// the checked capabilities; the two vocabularies are disjoint).
//
// Lexical, deliberately (the one-add-control-536 precedent): what is pinned is that a SECOND section
// or a scope pre-question does not come back. Behaviour (derivation, badges, the member toggle) is
// covered by the e2e specs (admin-roles-420 / roles-ia-469 / group-role-mapping-497).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(import.meta.dirname, "./AdminRolesTab.tsx"), "utf8");

describe("#536 one roles list, one creation flow", () => {
  it("has exactly one roles list container; the old per-section containers are gone", () => {
    expect(src.match(/data-testid="roles-list"/g)).toHaveLength(1);
    for (const dead of ['data-testid="builtin-tenant-roles"', 'data-testid="builtin-roles"', 'data-testid="custom-roles"']) {
      expect(src, `${dead} must stay deleted`).not.toContain(dead);
    }
  });

  it("creation asks no scope up front — the scope selector is gone and derivation exists", () => {
    expect(src).not.toContain('testId="role-scope"');
    // the derivation seam: save sends a scope computed from the checked capabilities
    expect(src).toMatch(/scope:\s*hasTenant\s*\?\s*"tenant"\s*:\s*"resource"/);
    // a mixed selection cannot save (the #445 exclusivity, surfaced at compose time)
    expect(src).toContain('data-testid="role-mixed-hint"');
    expect(src).toMatch(/disabled=\{pending \|\| !name\.trim\(\) \|\| caps\.length === 0 \|\| mixed\}/);
  });

  it("every row carries its scope as an attribute (badge), built-ins additionally say so", () => {
    expect(src).toContain('data-testid="role-scope-badge"');
    expect(src).toContain('data-testid="role-builtin-badge"');
  });

  // #536 ④: the ONE set is presented in TWO scope sections — tenant above, space/page below,
  // each built-in → custom (the re-ruling keeps "one set", changes the dividing axis to SCOPE).
  it(" ④: scope sections — tenant precedes space/page; each orders built-in → custom (DOM-pinned)", () => {
    const tenantHdr = src.indexOf('data-testid="roles-section-tenant"');
    const resourceHdr = src.indexOf('data-testid="roles-section-resource"');
    expect(tenantHdr, "tenant section exists").toBeGreaterThan(-1);
    expect(resourceHdr, "resource section exists").toBeGreaterThan(-1);
    expect(tenantHdr, "tenant section comes first").toBeLessThan(resourceHdr);
    // tenant section: built-ins (member/admin) precede its custom rows
    const tenantSeg = src.slice(tenantHdr, resourceHdr);
    expect(tenantSeg.indexOf('data-testid="builtin-role-member"')).toBeGreaterThan(-1);
    expect(tenantSeg.indexOf('data-testid="builtin-role-member"')).toBeLessThan(tenantSeg.indexOf('scope === "tenant"'));
    // resource section: built-in resource roles precede its custom rows
    const resourceSeg = src.slice(resourceHdr);
    expect(resourceSeg.indexOf("roles.data?.builtIn")).toBeGreaterThan(-1);
    expect(resourceSeg.indexOf("roles.data?.builtIn")).toBeLessThan(resourceSeg.indexOf('scope !== "tenant"'));
  });

  // #536 ③: the default-role "no selection" label says the TRUTH (everyone falls back to the
  // built-in member role) — not "None", which read as "no role at all".
  it(" ③: the default-role empty option names the member fallback (en/ja)", () => {
    for (const loc of ["en", "ja"]) {
      const j = JSON.parse(readFileSync(resolve(import.meta.dirname, `../i18n/locales/${loc}.json`), "utf8"));
      expect(j.adminRoles.defaultRoleNone, `${loc} names member`).toMatch(/member/);
    }
  });

  it("built-ins stay read-only in the same control custom roles edit with", () => {
    // the four resource built-ins and admin render CapabilityPicker with `disabled`
    expect(src).toMatch(/idPrefix=\{`builtin-\$\{r\.name\}`\} list=\{CAPABILITIES\} disabled/);
    expect(src).toMatch(/idPrefix="builtin-admin" list=\{TENANT_CAPABILITIES\} disabled/);
  });
});

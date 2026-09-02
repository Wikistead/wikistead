import { describe, it, expect } from "vitest";
import { memberStatusKeys, memberMenuValues } from "./member-status";

// #1054 / ADR-275 rev3 §4: "pending" rides beside the other marks, never in place of them — ADR-275
// §1's own "not a new state": a pending member is fully active, so the SAME row can wear idp/local +
// password + pending all at once, and the menu logic (unaware of the new field) must keep offering
// `suspend` exactly as it does for any other active row.
describe("memberStatusKeys — pending (#1054)", () => {
  it("an active member with nothing pending wears no pending mark", () => {
    expect(memberStatusKeys({ identity_source: "oidc", has_password: false, deactivated_at: null, pending_scim_removal_at: null }))
      .toEqual(["idp"]);
  });
  it("a pending member wears the mark ALONGSIDE its origin mark — not instead of it", () => {
    expect(memberStatusKeys({ identity_source: "oidc", has_password: false, deactivated_at: null, pending_scim_removal_at: "2026-09-01T00:00:00Z" }))
      .toEqual(["idp", "pending"]);
  });
  it("pending composes with every other mark at once (local + password-irrelevant + pending)", () => {
    expect(memberStatusKeys({ identity_source: "local", has_password: true, deactivated_at: null, pending_scim_removal_at: "2026-09-01T00:00:00Z" }))
      .toEqual(["local", "pending"]);
  });
  it("a pre-#1049 row with no pending field on the wire reads as not pending (absent, not undefined-crashes)", () => {
    expect(memberStatusKeys({ identity_source: "oidc", has_password: false, deactivated_at: null })).toEqual(["idp"]);
  });
});

describe("memberMenuValues is unaffected by pending — the CHECK/writer-clear already make it safe (#1054 ticket text)", () => {
  it("a pending (but still active) member offers suspend, the same as any other active member", () => {
    // memberMenuValues never reads pending_scim_removal_at at all — ADR-275 §1's CHECK constraint
    // guarantees deactivated_at IS NULL for a pending row, so the EXISTING deactivated_at-only branch
    // already does the right thing without needing to know about the new column.
    expect(memberMenuValues({ has_password: false, has_another_way_in: false, deactivated_at: null }))
      .toContain("suspend");
  });
});

// apiErrorFrom maps a server error body → ApiError, preserving the entitlement signals (#109 /
// ADR-072) so the UI can tell an entitlement loss (offer upgrade) from a plain failure. Defensive
// against non-object / non-JSON bodies. Pure (no fetch).
import { describe, it, expect } from "vitest";
import { apiErrorFrom, ApiError } from "./apiClient";

describe("apiErrorFrom (#109 error-body capture)", () => {
  it("captures code + upgrade from an entitlement-denial body", () => {
    const err = apiErrorFrom(403, "/api-keys", { statusCode: 403, code: "api_not_entitled", upgrade: true, message: "not on this plan" });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("api_not_entitled");
    expect(err.upgrade).toBe(true);
    expect(err.message).toBe("not on this plan"); // server message preferred
  });

  it("leaves code/upgrade undefined for a body without them (a plain authz/other error)", () => {
    const err = apiErrorFrom(404, "/pages/x", { error: "not found" });
    expect(err.code).toBeUndefined();
    expect(err.upgrade).toBeUndefined();
    expect(err.message).toBe("API 404 for /pages/x"); // generic fallback (no message field)
  });

  it("only honors upgrade===true (a falsy/non-boolean upgrade is ignored)", () => {
    expect(apiErrorFrom(403, "/x", { upgrade: "yes" }).upgrade).toBeUndefined();
    expect(apiErrorFrom(403, "/x", { upgrade: false }).upgrade).toBeUndefined();
  });

  it("is defensive against a non-object body (HTML error page / null)", () => {
    expect(apiErrorFrom(502, "/x", "<html>bad gateway</html>").message).toBe("API 502 for /x");
    expect(apiErrorFrom(500, "/x", null).code).toBeUndefined();
  });

  // #822 / #960: two door-closing refusals, two fields — and until this pin existed, NEITHER was
  // actually lifted onto the ApiError instance (the caller read them off the thrown error via a bare
  // cast that always resolved to undefined). Regressing either silently reopens that hole.
  it("lifts #822's remainingKind from a confirm_required body", () => {
    const err = apiErrorFrom(409, "/admin/connections/x", { statusCode: 409, code: "confirm_required", remainingKind: "oidc", message: "…" });
    expect(err.code).toBe("confirm_required");
    expect(err.remainingKind).toBe("oidc");
    expect(err.strandedSubs).toBeUndefined();
  });

  it("lifts #960's strandedSubs from a members_stranded body", () => {
    const err = apiErrorFrom(409, "/admin/connections/x", { error: "Conflict", code: "members_stranded", strandedSubs: ["a", "b"], message: "…" });
    expect(err.code).toBe("members_stranded");
    expect(err.strandedSubs).toEqual(["a", "b"]);
    expect(err.remainingKind).toBeUndefined();
  });

  it("ignores a malformed strandedSubs (not an array of strings)", () => {
    expect(apiErrorFrom(409, "/x", { code: "members_stranded", strandedSubs: "not-an-array" }).strandedSubs).toBeUndefined();
    expect(apiErrorFrom(409, "/x", { code: "members_stranded", strandedSubs: [1, 2] }).strandedSubs).toBeUndefined();
  });
});

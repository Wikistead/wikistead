import { describe, it, expect } from "vitest";
import { connectionsFor, connectionStartUrl, type LoginConnection } from "./LoginScreen";

// #537 §6 layout, re-aimed by #554 S3 (ADR-197 §3): the screen's truth is the ordered CONNECTION
// list; the legacy method synthesis (no `connections` field — pre-S3 server / failed fetch) keeps
// the old §6 semantics: OIDC outranks SAML, single method → no fold, empty ids → the
// connection-less legacy start URLs (N=1 byte-compat).
const conn = (kind: string, id = "", label: string | null = null): LoginConnection => ({ id, kind, label, brand: null });

describe("#554 S3 connectionsFor", () => {
  it("passes the server's ordered list through untouched (sort order = screen order)", () => {
    const list = [conn("oidc", "b-second"), conn("oidc", "a-first"), conn("platform", "platform")];
    expect(connectionsFor(list, [])).toBe(list);
  });
  it("legacy synthesis (§6): OIDC outranks SAML; single method degrades to one button; none → empty", () => {
    expect(connectionsFor(undefined, ["oidc", "saml"]).map((c) => c.kind)).toEqual(["oidc", "saml"]);
    expect(connectionsFor(undefined, ["oidc"]).map((c) => c.kind)).toEqual(["oidc"]);
    expect(connectionsFor(undefined, ["saml"]).map((c) => c.kind)).toEqual(["saml"]);
    expect(connectionsFor(undefined, [])).toEqual([]);
    for (const c of connectionsFor(undefined, ["oidc", "saml"])) expect(c.id, "legacy ids are empty → legacy URLs").toBe("");
  });
});

describe("#554 S3 connectionStartUrl", () => {
  it("a named connection starts by id; the legacy empty id keeps the connection-less URL byte-identical", () => {
    expect(connectionStartUrl(conn("oidc", "abc-123"), "/x")).toBe("/auth/login?connection=abc-123&returnTo=%2Fx");
    expect(connectionStartUrl(conn("oidc"), "/x")).toBe("/auth/login?returnTo=%2Fx");
    expect(connectionStartUrl(conn("platform", "platform"), "/")).toBe("/auth/login?connection=platform&returnTo=%2F");
  });
  it("SAML rides its own route (one per tenant — no id in the URL)", () => {
    expect(connectionStartUrl(conn("saml", "some-uuid"), "/x")).toBe("/auth/saml/login?returnTo=%2Fx");
  });
});

// #554 S3 review N4: the social start URL was the one fixed-in-S3 behavior with no pin — a bare
// URL regression would launch the CORPORATE IdP from a "Continue with Google" button (the provider
// hint is dropped on the tenant-IdP path) — plus the per-kind fixed wording (finding 4).
import { socialStartUrl, connectionButtonText } from "./LoginScreen";

describe("#554 S3 socialStartUrl", () => {
  it("names the platform connection so the hint survives beside a tenant IdP", () => {
    expect(socialStartUrl("platform", "google", "/")).toBe("/auth/login?connection=platform&provider=google&returnTo=%2F");
  });
  it("pre-S3 server (no platform id) keeps the bare legacy URL", () => {
    expect(socialStartUrl("", "github", "/x")).toBe("/auth/login?provider=github&returnTo=%2Fx");
  });
});

describe("#554 S3 connectionButtonText (ADR-197 §3 rev3 fixed branding)", () => {
  const t = (k: string) => k;
  it("platform and SAML wear FIXED first-party wording; oidc wears its label or the generic fallback", () => {
    expect(connectionButtonText(conn("platform", "platform"), t)).toBe("auth.signInPlatform");
    expect(connectionButtonText(conn("saml"), t)).toBe("auth.signInSaml");
    expect(connectionButtonText(conn("oidc", "x", "Corp SSO"), t)).toBe("Corp SSO");
    expect(connectionButtonText(conn("oidc", "x"), t)).toBe("auth.signIn");
  });
  it("#554 S4: a PRESET connection wears its fixed brand, and a label never rides through it", () => {
    expect(connectionButtonText({ id: "x", kind: "oidc", label: null, brand: "google" }, t)).toBe("auth.continueWith");
    expect(connectionButtonText({ id: "x", kind: "oidc", label: "Evil", brand: "microsoft" }, t)).toBe("auth.continueWith");
  });
});

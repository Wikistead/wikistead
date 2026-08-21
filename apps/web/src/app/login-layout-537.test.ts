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

// RETIRED by #602 / ADR-206 §3 (user ruling): `socialStartUrl` and the whole social start path are
// gone. What it guarded — "Continue with Google must not launch the corporate IdP" — cannot happen any
// more, because there is no second mechanism reaching the broker with a `?provider=` hint: signing in
// with Google is a preset CONNECTION, and a connection start URL names the connection by id. That
// property is pinned by `connectionStartUrl` above, which is now the only way in.
import { connectionButtonText } from "./LoginScreen";

describe("#554 S3 connectionButtonText (ADR-197 §3 rev3 fixed branding)", () => {
  const t = (k: string) => k;
  it("platform and SAML wear FIXED first-party wording; oidc wears its label or the generic fallback", () => {
    expect(connectionButtonText(conn("platform", "platform"), t)).toBe("auth.signInPlatform");
    expect(connectionButtonText(conn("saml"), t)).toBe("auth.signInSaml");
    expect(connectionButtonText(conn("oidc", "x", "Corp SSO"), t)).toBe("Corp SSO");
    // #798 / ADR-246 §2.1: the nameless fallback is no longer the verb the password form's submit
    // button also uses. The property that fallback exists for is pinned on the rendered screen in
    // every-way-in-names-itself-798.test.ts; this line only follows the key.
    expect(connectionButtonText(conn("oidc", "x"), t)).toBe("auth.signInSso");
  });
  it("#554 S4: a PRESET connection wears its fixed brand, and a label never rides through it", () => {
    expect(connectionButtonText({ id: "x", kind: "oidc", label: null, brand: "google" }, t)).toBe("auth.continueWith");
    expect(connectionButtonText({ id: "x", kind: "oidc", label: "Evil", brand: "microsoft" }, t)).toBe("auth.continueWith");
  });
});

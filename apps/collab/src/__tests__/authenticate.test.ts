// Integration tests for the collab join point (real OpenFGA). Covers the new
// member-collab-token path (P1.1 C4) plus the dev bypass. The token asserts
// identity; authority is re-derived from OpenFGA per document.
import { describe, it, expect, afterAll } from "vitest";
import { mintMemberCollabToken, mintGuestToken } from "@wikistead/auth";
import { fgaClient, writeTuples, deleteTuples } from "@wikistead/authz";
import { authenticate } from "../authenticate.js";

const cfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 };
const DOC = "t:tenant_dev:p:demo"; // dev-user is manager of demo_space (fga:seed)

describe("collab authenticate — member collab token", () => {
  it("admits a member with access; authority comes from OpenFGA, not the token", async () => {
    const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_dev", sub: "dev-user", groups: [] });
    const r = await authenticate({ token, documentName: DOC });
    expect(r.principal).toMatchObject({ kind: "member", tenantId: "tenant_dev", userId: "dev-user" });
    expect(r.readOnly).toBe(false);
  });

  it("rejects a token whose tenant ≠ the document's tenant (cross-tenant)", async () => {
    const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_acme", sub: "dev-user", groups: [] });
    await expect(authenticate({ token, documentName: DOC })).rejects.toThrow(/tenant mismatch/);
  });

  it("rejects a validly-signed token for a subject with NO FGA access (identity ≠ authority)", async () => {
    const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_dev", sub: "collab-stranger-c4", groups: [] });
    await expect(authenticate({ token, documentName: DOC })).rejects.toThrow(/no access/);
  });

  it("dev-token bypass still works (dev only)", async () => {
    const r = await authenticate({ token: "dev-token", documentName: DOC });
    expect(r.principal).toMatchObject({ kind: "member", userId: "dev-user" });
  });

  // P3 two-layer edit defense (the fortress): a member with ONLY view authority
  // is admitted read-only, so even if the client forges the Edit button, the
  // collab connection rejects writes server-side. Authority is FGA, not the UI.
  it("admits a view-only member as readOnly (server is the write fortress)", async () => {
    const VIEWER = "collab-viewonly-p3";
    await writeTuples(fgaClient, [{ user: `user:${VIEWER}`, relation: "view", object: "page:demo" }]);
    try {
      const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_dev", sub: VIEWER, groups: [] });
      const r = await authenticate({ token, documentName: DOC });
      expect(r.principal).toMatchObject({ kind: "member", userId: VIEWER });
      expect(r.readOnly).toBe(true); // view ⇒ read-only ⇒ Hocuspocus rejects writes
    } finally {
      await deleteTuples(fgaClient, [{ user: `user:${VIEWER}`, relation: "view", object: "page:demo" }]).catch(() => {});
    }
  });
});

// #106 / ADR-028: active disconnect severs connected guests on revoke, but the disconnect is
// only safe because a severed guest CANNOT rejoin. Revocation = deleting the share_link tuple;
// onAuthenticate re-derives authority from FGA on every connect, so the same (still
// structurally valid) token is rejected after revoke. Without this, reconnect-after-disconnect
// would make the active disconnect pointless.
describe("collab authenticate — guest token, reconnect blocked after revoke", () => {
  const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 };
  const LINK = "revoke-test-link-106";
  const tuple = { user: `share_link:${LINK}`, relation: "view", object: "page:demo" };

  it("admits a guest while the tuple exists; rejects the SAME token after the tuple is deleted", async () => {
    await writeTuples(fgaClient, [tuple]);
    const token = await mintGuestToken(guestCfg, {
      tenantId: "tenant_dev", shareLinkId: LINK, resource: { type: "page", id: "demo" }, capability: "view",
    });
    try {
      const ok = await authenticate({ token, documentName: DOC });
      expect(ok.principal).toMatchObject({ kind: "guest", shareLinkId: LINK });

      // Revoke (the active-disconnect authority). A reconnect with the same token must fail.
      await deleteTuples(fgaClient, [tuple]);
      await expect(authenticate({ token, documentName: DOC })).rejects.toThrow(/denied|expired|forbidden/);
    } finally {
      await deleteTuples(fgaClient, [tuple]).catch(() => {});
    }
  });
});

// Integration tests for the collab join point (real OpenFGA). Covers the new
// member-collab-token path (P1.1 C4) plus the dev bypass. The token asserts
// identity; authority is re-derived from OpenFGA per document.
import { describe, it, expect, afterAll } from "vitest";
import { mintMemberCollabToken } from "@wikistead/auth";
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

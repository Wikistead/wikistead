// #471 / ADR-176: the collab join point is a separate process, so the HTTP seam does not cover it.
// Its guest and member-collab-token branches asserted the token's tenant CLAIM matched the room's
// tenant; the OIDC bearer branch asserted nothing at all. On a page reachable through
// `view_base@user:*` — a published public page — `checkMemberAccess` then returned access, so an
// outsider joined the room, appeared in presence and read the live document. A claim is not
// authority in any case: membership is, and it is now required of every member principal here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from "jose";
import { mintMemberCollabToken } from "@wikistead/auth";
import { fgaClient, writeTuples, deleteTuples, deleteObjectTuples } from "@wikistead/authz";

const cfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 };
const PAGE = "collab-mb471-public";
const SPACE = "collab-mb471-space";
const DOC = `t:tenant_dev:p:${PAGE}`;
const OUTSIDER = "collab-mb471-outsider"; // authenticates fine; belongs to no tenant here

// A PUBLIC page: the wildcard is the whole point — it is what let an outsider through.
const TUPLES = [
  { user: "tenant:tenant_dev", relation: "tenant", object: `space:${SPACE}` },
  { user: `space:${SPACE}`, relation: "space", object: `page:${PAGE}` },
  { user: "user:*", relation: "published", object: `page:${PAGE}` },
  { user: "share_link:*", relation: "published", object: `page:${PAGE}` },
  { user: "user:*", relation: "view_base", object: `page:${PAGE}` },
];

let jwks: { url: string; mint: (sub: string, claims?: Record<string, unknown>) => Promise<string>; close: () => Promise<void> };
let authenticate: typeof import("../authenticate.js").authenticate;

async function startJwksIssuer(issuerUrl: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "cmb471", alg: "RS256", use: "sig" });
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/jwks`,
    mint: (sub: string, claims: Record<string, unknown> = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "cmb471" })
        .setIssuer(issuerUrl).setSubject(sub).setIssuedAt().setExpirationTime("5m")
        .sign(privateKey as KeyLike),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeAll(async () => {
  const issuer = "https://idp.cmb471.test/";
  jwks = await startJwksIssuer(issuer);
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_JWKS_URI = jwks.url;
  // imported AFTER the env is set: the verifier is built when the module is first evaluated
  ({ authenticate } = await import("../authenticate.js"));
  for (const t of TUPLES) await deleteTuples(fgaClient, [t]).catch(() => {});
  await writeTuples(fgaClient, TUPLES);
});

afterAll(async () => {
  await deleteObjectTuples(fgaClient, `page:${PAGE}`).catch(() => {});
  await deleteObjectTuples(fgaClient, `space:${SPACE}`).catch(() => {});
  await deleteTuples(fgaClient, [{ user: `user:${OUTSIDER}`, relation: "member", object: "tenant:tenant_dev" }]).catch(() => {});
  await jwks.close();
});

describe("#471 / ADR-176: collab room membership", () => {
  it("refuses an OIDC bearer from outside the tenant, even on a public page", async () => {
    const token = await jwks.mint(OUTSIDER);
    await expect(authenticate({ token, documentName: DOC })).rejects.toThrow(/not a member/);
  });

  it("admits the same subject once they are a member — the page grant was never the question", async () => {
    await writeTuples(fgaClient, [{ user: `user:${OUTSIDER}`, relation: "member", object: "tenant:tenant_dev" }]);
    const r = await authenticate({ token: await jwks.mint(OUTSIDER), documentName: DOC });
    expect(r.principal).toMatchObject({ kind: "member", tenantId: "tenant_dev", userId: OUTSIDER });
    expect(r.readOnly, "public view only — the wildcard grants reading, not writing").toBe(true);
  });

  it("accepts a tenant claim naming the tenant by SLUG, as the HTTP seam does", async () => {
    // an IdP mints human names, not our internal ids — and a token that authenticates over HTTP and
    // then cannot open the document it just fetched is worse than no claim check at all
    await writeTuples(fgaClient, [{ user: `user:${OUTSIDER}`, relation: "member", object: "tenant:tenant_dev" }]).catch(() => {});
    const bySlug = await jwks.mint(OUTSIDER, { tenant: "dev" });
    const r = await authenticate({ token: bySlug, documentName: DOC });
    expect(r.principal).toMatchObject({ kind: "member", userId: OUTSIDER });
    // …while a claim naming somewhere else is still refused
    await expect(authenticate({ token: await jwks.mint(OUTSIDER, { tenant: "somewhere-else" }), documentName: DOC }))
      .rejects.toThrow(/tenant mismatch/);
  });

  it("refuses a member-collab token whose subject has since been removed", async () => {
    const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_dev", sub: OUTSIDER, groups: [] });
    await deleteTuples(fgaClient, [{ user: `user:${OUTSIDER}`, relation: "member", object: "tenant:tenant_dev" }]);
    await expect(authenticate({ token, documentName: DOC }), "checked per join, not at token expiry").rejects.toThrow(/not a member/);
  });
});

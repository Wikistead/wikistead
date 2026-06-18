// Realtime collaboration server (Yjs + Hocuspocus). This is the security-critical
// join point: a single onAuthenticate accepts BOTH member (OIDC) and guest
// (app-signed share) tokens, resolves capability for the requested document, and
// enforces it before letting anyone into the Yjs room. Rooms are tenant-namespaced.
import { Hocuspocus } from "@hocuspocus/server";
import type { onAuthenticatePayload } from "@hocuspocus/server";
import { Redis } from "@hocuspocus/extension-redis";
import {
  looksLikeGuestToken,
  verifyGuestToken,
  makeMemberVerifier,
} from "@kb/auth";
import { fgaClient, check, checkMemberAccess } from "@kb/authz";
import { docName } from "@kb/types";

const guestCfg = {
  secret: process.env.GUEST_TOKEN_SECRET!,
  ttlSeconds: Number(process.env.GUEST_TOKEN_TTL_SECONDS ?? 3600),
};
const verifyMember = makeMemberVerifier({
  issuer: process.env.OIDC_ISSUER!,
  jwksUri: process.env.OIDC_JWKS_URI!,
});

const server = new Hocuspocus({
  port: Number(process.env.COLLAB_PORT ?? 4100),

  extensions: [
    new Redis({ host: hostFromUrl(process.env.VALKEY_URL), port: portFromUrl(process.env.VALKEY_URL) }),
    // TODO(phase: collab): add @hocuspocus/extension-database to persist Y.Text
    //                      updates to Postgres + periodic named snapshots.
  ],

  async onAuthenticate({ token, documentName, requestParameters }: onAuthenticatePayload) {
    // documentName is "t:<tenantId>:p:<pageId>" — never trust the client; we
    // re-derive what they're allowed to do regardless of what they claim.
    const { tenantId, pageId } = parseDocName(documentName);

    // Dev-only bypass: allows the hardcoded "dev-token" from apps/web/src/main.ts
    // to connect without real OIDC. Disabled in production at the env level.
    if (process.env.NODE_ENV !== "production" && token === "dev-token") {
      return {
        principal: { kind: "member", tenantId, userId: "dev-user", groups: [] },
        readOnly: false,
      };
    }

    if (looksLikeGuestToken(token)) {
      const c = await verifyGuestToken(guestCfg, token);
      assert(c.tenantId === tenantId, "tenant mismatch");
      assert(c.resource.type === "page" && c.resource.id === pageId, "resource mismatch");

      // Re-check against OpenFGA: the JWT asserts intent, FGA asserts authority.
      // A revoked link (tuple deleted) or expired Condition is rejected here even
      // if the JWT is still structurally valid. Revocation is enforced at next
      // onAuthenticate call (connected guests hold the JWT until exp).
      const allowed = await check(
        fgaClient,
        `share_link:${c.shareLinkId}`,
        c.capability === "view" ? "view" : "edit",
        { type: "page", id: pageId },
        { current_time: new Date().toISOString() },
      );
      assert(allowed, "share_link access denied or expired");

      return {
        principal: { kind: "guest", tenantId, shareLinkId: c.shareLinkId, capability: c.capability },
        readOnly: c.capability === "view",
      };
    }

    const m = await verifyMember(token);
    // One batchCheck round-trip: edit + view → RW / RO / reject.
    const access = await checkMemberAccess(fgaClient, m.sub, { type: "page", id: pageId });
    assert(access !== null, "member has no access to this page");

    return {
      principal: { kind: "member", tenantId, userId: m.sub, groups: m.groups },
      readOnly: access.readOnly,
    };
  },
});

server.listen();

// ---- helpers ----
function parseDocName(name: string): { tenantId: string; pageId: string } {
  const m = /^t:(.+?):p:(.+)$/.exec(name);
  if (!m) throw new Error(`bad document name: ${name}`);
  return { tenantId: m[1], pageId: m[2] };
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`forbidden: ${msg}`); }
function hostFromUrl(u?: string) { return u ? new URL(u).hostname : "localhost"; }
function portFromUrl(u?: string) { return u ? Number(new URL(u).port || 6379) : 6379; }

export { docName };

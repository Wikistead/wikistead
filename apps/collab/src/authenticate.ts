// The security-critical join point, extracted from the Hocuspocus config so it is
// directly testable. A single function authenticates ALL principal kinds and
// re-derives authority from OpenFGA — never trusting documentName or the token's
// claims about what it may do.
import {
  looksLikeGuestToken,
  verifyGuestToken,
  looksLikeMemberCollabToken,
  verifyMemberCollabToken,
  makeMemberVerifier,
} from "@wikistead/auth";
import { fgaClient, check, checkMemberAccess } from "@wikistead/authz";

const guestCfg = {
  secret: process.env.GUEST_TOKEN_SECRET!,
  ttlSeconds: Number(process.env.GUEST_TOKEN_TTL_SECONDS ?? 3600),
};
const verifyMember = makeMemberVerifier({
  issuer: process.env.OIDC_ISSUER!,
  jwksUri: process.env.OIDC_JWKS_URI!,
});

export interface AuthResult {
  principal:
    | { kind: "member"; tenantId: string; userId: string; groups: string[] }
    | { kind: "guest"; tenantId: string; shareLinkId: string; capability: string };
  readOnly: boolean;
}

export function parseDocName(name: string): { tenantId: string; pageId: string } {
  const m = /^t:(.+?):p:(.+)$/.exec(name);
  if (!m) throw new Error(`bad document name: ${name}`);
  return { tenantId: m[1], pageId: m[2] };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`forbidden: ${msg}`);
}

export async function authenticate(args: { token: string; documentName: string }): Promise<AuthResult> {
  // Never trust documentName — re-derive tenant + page and authorize against them.
  const { tenantId, pageId } = parseDocName(args.documentName);
  const token = args.token;

  // Dev-only bypass (disabled in production at the env level).
  if (process.env.NODE_ENV !== "production" && token === "dev-token") {
    return { principal: { kind: "member", tenantId, userId: "dev-user", groups: [] }, readOnly: false };
  }

  if (looksLikeGuestToken(token)) {
    const c = await verifyGuestToken(guestCfg, token);
    assert(c.tenantId === tenantId, "tenant mismatch");
    assert(c.resource.type === "page" && c.resource.id === pageId, "resource mismatch");
    // JWT asserts intent; OpenFGA asserts authority (revoked/expired links fail here).
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

  // App-signed member token (browser BFF). Identity from the token; authority from
  // OpenFGA, re-checked per document — same discipline as guests.
  if (looksLikeMemberCollabToken(token)) {
    const c = await verifyMemberCollabToken(guestCfg, token);
    assert(c.tenantId === tenantId, "tenant mismatch");
    const access = await checkMemberAccess(fgaClient, c.sub, { type: "page", id: pageId });
    assert(access !== null, "member has no access to this page");
    return {
      principal: { kind: "member", tenantId, userId: c.sub, groups: c.groups },
      readOnly: access.readOnly,
    };
  }

  // OIDC bearer member token (programmatic).
  const m = await verifyMember(token);
  const access = await checkMemberAccess(fgaClient, m.sub, { type: "page", id: pageId });
  assert(access !== null, "member has no access to this page");
  return { principal: { kind: "member", tenantId, userId: m.sub, groups: m.groups }, readOnly: access.readOnly };
}

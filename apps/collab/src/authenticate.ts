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

// #92 / ADR-093: an EPHEMERAL room for level-2 Excalidraw co-editing is `t:<tenant>:p:<pageId>:x:<anchor>`.
// It resolves to the SAME page as the normal room but is never persisted (index.ts) and requires EDIT
// (co-editing the drawing = editing the page). pageIds are colon-free uuids, so the `:x:` suffix is an
// unambiguous discriminant; the ephemeral pattern is tested FIRST (the page pattern's greedy tail would
// otherwise swallow it).
export function parseDocName(name: string): { tenantId: string; pageId: string; ephemeral: boolean } {
  const ex = /^t:(.+?):p:(.+?):x:.+$/.exec(name);
  if (ex) return { tenantId: ex[1], pageId: ex[2], ephemeral: true };
  const m = /^t:(.+?):p:(.+)$/.exec(name);
  if (!m) throw new Error(`bad document name: ${name}`);
  return { tenantId: m[1], pageId: m[2], ephemeral: false };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`forbidden: ${msg}`);
}

export async function authenticate(args: { token: string; documentName: string }): Promise<AuthResult> {
  // Never trust documentName — re-derive tenant + page and authorize against them.
  const { tenantId, pageId, ephemeral } = parseDocName(args.documentName);
  const token = args.token;

  // Dev-only bypass (disabled in production at the env level).
  if (process.env.NODE_ENV !== "production" && token === "dev-token") {
    return { principal: { kind: "member", tenantId, userId: "dev-user", groups: [] }, readOnly: false };
  }

  if (looksLikeGuestToken(token)) {
    const c = await verifyGuestToken(guestCfg, token);
    assert(c.tenantId === tenantId, "tenant mismatch");
    // A PAGE token is bound to exactly one page. A SPACE token (ADR-038 / #104) admits the
    // guest to ANY page that inherits view from the space (i.e. a published page in that
    // space) — so we do NOT assert a page-id match for it; the OpenFGA check below is the
    // authority (page#view ← viewer from space). A space link is view-only.
    if (c.resource.type === "page") {
      assert(c.resource.id === pageId, "resource mismatch");
    } else {
      assert(c.resource.type === "space", "unsupported resource");
    }
    const capability = c.resource.type === "space" ? "view" : c.capability;
    // #92: an EPHEMERAL Excalidraw room is co-editing → it requires EDIT (a view/comment guest cannot
    // join it). Otherwise: only EDIT is writable; a view OR comment guest joins read-only (a comment
    // guest comments via the HTTP API, not by editing the doc) — so the FGA check is 'edit' for an edit
    // token (or any ephemeral join), else 'view'. JWT asserts intent; OpenFGA asserts authority
    // (revoked/expired links fail here). A space token resolves via viewer-from-space (published pages
    // in S only, never another space / a draft / after revoke) and is view-only (so never ephemeral).
    const needEdit = ephemeral || capability === "edit";
    const allowed = await check(
      fgaClient,
      `share_link:${c.shareLinkId}`,
      needEdit ? "edit" : "view",
      { type: "page", id: pageId },
      { current_time: new Date().toISOString() },
    );
    assert(allowed, "share_link access denied or expired");
    if (ephemeral) assert(capability === "edit", "ephemeral room requires an edit link");
    return {
      principal: { kind: "guest", tenantId, shareLinkId: c.shareLinkId, capability },
      readOnly: capability !== "edit",
    };
  }

  // App-signed member token (browser BFF). Identity from the token; authority from
  // OpenFGA, re-checked per document — same discipline as guests.
  if (looksLikeMemberCollabToken(token)) {
    const c = await verifyMemberCollabToken(guestCfg, token);
    assert(c.tenantId === tenantId, "tenant mismatch");
    const access = await checkMemberAccess(fgaClient, c.sub, { type: "page", id: pageId });
    assert(access !== null, "member has no access to this page");
    if (ephemeral) assert(!access.readOnly, "ephemeral room requires edit"); // #92: co-editing = edit
    return {
      principal: { kind: "member", tenantId, userId: c.sub, groups: c.groups },
      readOnly: access.readOnly,
    };
  }

  // OIDC bearer member token (programmatic).
  const m = await verifyMember(token);
  const access = await checkMemberAccess(fgaClient, m.sub, { type: "page", id: pageId });
  assert(access !== null, "member has no access to this page");
  if (ephemeral) assert(!access.readOnly, "ephemeral room requires edit"); // #92: co-editing = edit
  return { principal: { kind: "member", tenantId, userId: m.sub, groups: m.groups }, readOnly: access.readOnly };
}

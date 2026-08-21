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
import { fgaClient, check, checkMemberAccess, isTenantMember } from "@wikistead/authz";
import { externalSubViolation } from "@wikistead/hooks";
import { pool } from "./db.js";

// #813 / ADR-248 §3.8: verifying reads the expiry out of the token, so this side has no business
// naming a lifetime. It used to carry a default of its own — one that disagreed with the minter's.
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET! };
const verifyMember = makeMemberVerifier({
  issuer: process.env.OIDC_ISSUER!,
  jwksUri: process.env.OIDC_JWKS_URI!,
});

export interface AuthResult {
  principal:
    | { kind: "member"; tenantId: string; userId: string; groups: string[] }
    // #328 / ADR-140 increment 2: `anonId` (#331 / ADR-138 pseudonymous session id, from the VERIFIED token
    // claim) rides along so the caller (index.ts) can key the per-session connect rate bucket. Identity
    // metadata only — it is never an authority (the FGA check above remains the sole gate), and it is
    // absent on a token minted before #331.
    | { kind: "guest"; tenantId: string; shareLinkId: string; capability: string; anonId?: string };
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

// The room's tenant slug, for the advisory claim comparison below. Cached: it never changes for a
// live room, and this must not add a query to every join.
const slugCache = new Map<string, string>();
async function tenantSlug(tenantId: string): Promise<string> {
  const hit = slugCache.get(tenantId);
  if (hit !== undefined) return hit;
  const [row] = await pool<{ slug: string }[]>`SELECT slug FROM tenants WHERE id = ${tenantId}`;
  const slug = row?.slug ?? "";
  if (slug) slugCache.set(tenantId, slug);
  return slug;
}

export async function authenticate(args: { token: string; documentName: string }): Promise<AuthResult> {
  // Never trust documentName — re-derive tenant + page and authorize against them.
  const { tenantId, pageId, ephemeral } = parseDocName(args.documentName);
  const token = args.token;

  // #471 / ADR-176: a member principal is admitted to this room only if they are a member of the
  // room's tenant. The two branches below already asserted the token's tenant CLAIM matched; the
  // OIDC branch asserted nothing at all, so a token from another tenant joined any room whose page
  // was reachable through `view_base@user:*` — a public page — and read the live document and
  // appeared in presence. A claim is not authority in any case: membership is, per request, the same
  // predicate the HTTP seam and login use.
  const asMember = async (userId: string, groups: string[], readOnly: boolean): Promise<AuthResult> => {
    assert(await isTenantMember(fgaClient, userId, tenantId), "not a member of this tenant");
    return { principal: { kind: "member", tenantId, userId, groups }, readOnly };
  };

  // Dev-only bypass (disabled in production at the env level).
  if (process.env.NODE_ENV !== "production" && token === "dev-token") {
    return asMember("dev-user", [], false);
  }

  if (looksLikeGuestToken(token)) {
    const c = await verifyGuestToken(guestCfg, token);
    assert(c.tenantId === tenantId, "tenant mismatch");
    // #218 / ADR-103 (A5-4): a PAGE token admits to its page AND — for a FOLDER link — its DESCENDANT docs,
    // because the share_link's view/edit grant cascades down the parent chain in the model. So we do NOT assert
    // resource.id === pageId; the OpenFGA check below is the authority (a non-folder link's grant reaches only
    // its own page, so the common case stays exact; a folder link additionally reaches its subtree per the
    // link's capability). A SPACE token (ADR-038 / #104 / #274) likewise resolves via the FGA
    // check — viewer from space for a view link, editor from space for an edit link. Same "trust FGA,
    // not the token's page claim" discipline for both.
    if (c.resource.type !== "page" && c.resource.type !== "space") {
      assert(false, "unsupported resource");
    }
    // #812 / ADR-135: the token's capability is honoured for a SPACE link exactly as for a page link.
    // Until #812 a space token was forced to "view" here — a fossil of ADR-038, when `space#editor` had
    // no share_link type and a space link could only ever read. #274 / ADR-135 split the relation and
    // made the space EDIT link (the anonymous-wiki face) a first-class product surface, so forcing view
    // demoted every space edit-link guest to read-only the moment readOnly was actually enforced (#811).
    const capability = c.capability;
    // #92: an EPHEMERAL Excalidraw room is co-editing → it requires EDIT (a view/comment guest cannot
    // join it). Otherwise: only EDIT is writable; a view OR comment guest joins read-only (a comment
    // guest comments via the HTTP API, not by editing the doc) — so the FGA check is 'edit' for an edit
    // token (or any ephemeral join), else 'view'. JWT asserts intent; OpenFGA asserts authority
    // (revoked/expired links fail here). A space token resolves through the space: a VIEW link via
    // viewer-from-space, an EDIT link via editor-from-space — published, non-private pages in S only,
    // never another space / a draft / after revoke. A space EDIT link reaches the ephemeral Excalidraw
    // room too (#811 ruling 3: the same co-editing power as a page edit link).
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
      principal: { kind: "guest", tenantId, shareLinkId: c.shareLinkId, capability, anonId: c.anonId },
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
    return asMember(c.sub, c.groups, access.readOnly);
  }

  // OIDC bearer member token (programmatic). The token's own tenant claim, when it carries one, must
  // agree with the room's tenant — matching the two branches above — and membership settles it.
  // The claim may name the tenant by id or by slug, exactly as the HTTP seam accepts it: a token an
  // IdP mints is far likelier to carry a human name than our internal id, and an asymmetry here
  // would mean the same token authenticates over HTTP and then cannot open the document it just
  // fetched.
  const m = await verifyMember(token);
  // #554 / ADR-197 §5 (S0, seam 8): the collab WS twin of the HTTP bearer seam — an externally-
  // asserted sub wearing a reserved internal prefix (or outside the FGA-safe grammar) never becomes
  // a room principal (it would join presence AS the spoofed member). Refused with this branch's own
  // membership failure, never a distinguishable oracle. The other branches stay ungated on purpose:
  // dev-token is internal, guests are `share_link:` subjects, the member collab token is minted by
  // our server from an already-admitted session sub.
  assert(!externalSubViolation(m.sub), "not a member of this tenant");
  assert(!m.tenantId || m.tenantId === tenantId || m.tenantId === (await tenantSlug(tenantId)), "tenant mismatch");
  const access = await checkMemberAccess(fgaClient, m.sub, { type: "page", id: pageId });
  assert(access !== null, "member has no access to this page");
  if (ephemeral) assert(!access.readOnly, "ephemeral room requires edit"); // #92: co-editing = edit
  return asMember(m.sub, m.groups, access.readOnly);
}

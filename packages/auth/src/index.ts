// Token minting/verification for the two principal kinds.
// MEMBERS  -> OIDC (Authentik). Verified against the IdP JWKS.
// GUESTS   -> app-signed, short-lived share tokens. We mint AND verify these.
//
// Design (locked): guests are NEVER OIDC accounts. They never become tenant
// members and never count toward billing seats. Revocation is handled in the
// authz graph (delete the share_link tuple) + short token TTL + silent refresh.

import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import { createHmac, randomBytes } from "node:crypto";
import type { GuestTokenClaims, Principal, Capability, ResourceRef } from "@wikistead/types";

const enc = new TextEncoder();

// #331 / ADR-138 (C-6): derive a pseudonymous per-session id for an anonymous editor — `anon:<12 hex>` =
// HMAC-SHA256(secret, CSPRNG nonce), truncated to 12 hex (48 bits — well past the birthday domain for a
// tenant's guest sessions, so C-2 rollback-by-actor keys don't collide). NOT derived from any PII / raw IP
// (GDPR — the nonce is fresh randomness, keyed by the guest secret so it can't be enumerated). Irreversible;
// the correlation window is the session (token TTL). One session = one pseudonym.
export function deriveAnonId(secret: string): string {
  const digest = createHmac("sha256", secret).update(randomBytes(16)).digest("hex");
  return `anon:${digest.slice(0, 12)}`;
}

/**
 * What VERIFYING a token needs: the signing secret, and nothing else.
 *
 * #813 / ADR-248 §3.8: a lifetime is a minting decision — the expiry a verifier enforces is inside
 * the token it is reading. Two call sites nevertheless built a full config to verify with, each
 * carrying its own default, and those defaults disagreed with the one the minter actually uses. The
 * values were dead, but "how long does a guest's credential live" had three published answers and the
 * environment reference shipped the wrong one. Splitting the type is what keeps a fourth from
 * appearing: a verifier that cannot be handed a lifetime cannot invent one.
 */
export interface TokenSecret {
  secret: string;
}

/** What MINTING a token needs: the secret, and how long the token lives. */
export interface GuestTokenConfig extends TokenSecret {
  ttlSeconds: number;
}

/** Mint a short-lived guest token bound to a single share link + resource. */
export async function mintGuestToken(
  cfg: GuestTokenConfig,
  // #331 / ADR-138: `anonId` is minted here (at share-link token exchange) and embedded in the claim. A caller
  // that silently REFRESHES a still-live session passes the EXISTING anonId so the pseudonym is stable across
  // the refresh (one session = one pseudonym); a fresh exchange omits it → a new pseudonym.
  args: { tenantId: string; shareLinkId: string; resource: ResourceRef; capability: Capability; anonId?: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tenantId: args.tenantId,
    shareLinkId: args.shareLinkId,
    resource: args.resource,
    capability: args.capability,
    anonId: args.anonId ?? deriveAnonId(cfg.secret),
  })
    .setProtectedHeader({ alg: "HS256", typ: "guest+jwt" })
    .setIssuedAt(now)
    .setExpirationTime(now + cfg.ttlSeconds)
    .sign(enc.encode(cfg.secret));
}

export async function verifyGuestToken(cfg: TokenSecret, token: string): Promise<GuestTokenClaims> {
  const { payload } = await jwtVerify(token, enc.encode(cfg.secret), { typ: "guest+jwt" });
  // NOTE: structural validation only; capability is re-checked against OpenFGA
  // at the authorization boundary. The token asserts intent, not authority.
  return payload as unknown as GuestTokenClaims;
}

// ── Member collab tokens (P1.1 C4) ──────────────────────────────────────────
// Browser members authenticate to the API via a host-only session cookie (BFF),
// but the collab WebSocket is token-based. So the API mints a SHORT-LIVED,
// app-signed member token from the session; collab verifies it and re-derives
// per-document access from OpenFGA (the token asserts identity, not authority —
// same rule as guest tokens). Distinct typ from guest so one socket can tell them
// apart. Reuses the guest signing secret.
export interface MemberCollabClaims {
  tenantId: string;
  sub: string;
  groups: string[];
}

export async function mintMemberCollabToken(
  cfg: GuestTokenConfig,
  args: { tenantId: string; sub: string; groups: string[] },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ tenantId: args.tenantId, sub: args.sub, groups: args.groups })
    .setProtectedHeader({ alg: "HS256", typ: "member+jwt" })
    .setIssuedAt(now)
    .setExpirationTime(now + cfg.ttlSeconds)
    .sign(enc.encode(cfg.secret));
}

export async function verifyMemberCollabToken(cfg: TokenSecret, token: string): Promise<MemberCollabClaims> {
  const { payload } = await jwtVerify(token, enc.encode(cfg.secret), { typ: "member+jwt" });
  return payload as unknown as MemberCollabClaims;
}

export function looksLikeMemberCollabToken(token: string): boolean {
  try {
    const [h] = token.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    return header?.typ === "member+jwt";
  } catch {
    return false;
  }
}

// ── MCP access tokens (#311 / ADR-131 slice 4) ─────────────────────────────
// The OAuth 2.1 token endpoint mints this app-signed access token from an authorization
// code. Like the member/guest tokens it asserts IDENTITY, not authority — the /mcp tools
// re-derive access from OpenFGA on `user:<sub>` per request. It is TENANT-BOUND: the
// `tenantId` claim must equal the Host-resolved tenant on every /mcp request (a token
// minted for tenant A is rejected at tenant B). Distinct typ so one endpoint can tell it
// apart. Reuses the same signing secret.
export interface McpAccessClaims {
  tenantId: string;
  sub: string;
  scopes: string[];
  // The member's groups, carried so a tool (e.g. search) can honour group-granted access without a
  // reverse lookup. Identity metadata only — OpenFGA remains the authority per operation.
  groups: string[];
}

export async function mintMcpAccessToken(
  cfg: GuestTokenConfig,
  args: { tenantId: string; sub: string; scopes: string[]; groups: string[] },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ tenantId: args.tenantId, sub: args.sub, scopes: args.scopes, groups: args.groups })
    .setProtectedHeader({ alg: "HS256", typ: "mcp+jwt" })
    .setIssuedAt(now)
    .setExpirationTime(now + cfg.ttlSeconds)
    .sign(enc.encode(cfg.secret));
}

export async function verifyMcpAccessToken(cfg: TokenSecret, token: string): Promise<McpAccessClaims> {
  const { payload } = await jwtVerify(token, enc.encode(cfg.secret), { typ: "mcp+jwt" });
  return payload as unknown as McpAccessClaims;
}

// ── Email unsubscribe tokens (#547 / ADR-196 §3) ────────────────────────────
// The emailed unsubscribe link carries this TENANT-BOUND token. Same discipline as the other typs:
// it asserts intent for exactly one (tenant, member, pref); the route re-checks the Host-resolved
// tenant against the claim (a token minted for tenant A is a uniform 404 at tenant B). A NEW typ —
// not a new scheme — is the token-confusion guard: none of the other verifiers will accept it, and
// this verifier accepts none of theirs. GET confirms, POST mutates (RFC 8058 one-click is a POST);
// the token itself never grants anything but the single pref flip.
export interface UnsubTokenClaims {
  tenantId: string;
  sub: string;
  action: "immediate" | "digest";
}

export async function mintUnsubToken(
  cfg: GuestTokenConfig,
  args: { tenantId: string; sub: string; action: "immediate" | "digest" },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ tenantId: args.tenantId, sub: args.sub, action: args.action })
    .setProtectedHeader({ alg: "HS256", typ: "unsub+jwt" })
    .setIssuedAt(now)
    .setExpirationTime(now + cfg.ttlSeconds)
    .sign(enc.encode(cfg.secret));
}

export async function verifyUnsubToken(cfg: TokenSecret, token: string): Promise<UnsubTokenClaims> {
  const { payload } = await jwtVerify(token, enc.encode(cfg.secret), { typ: "unsub+jwt" });
  return payload as unknown as UnsubTokenClaims;
}

export interface OidcConfig {
  issuer: string;
  jwksUri: string;
  audience?: string;
}

/** Verify an OIDC member access/id token against the IdP JWKS. */
export function makeMemberVerifier(cfg: OidcConfig) {
  // Lazy: createRemoteJWKSet is deferred until the first token verification so
  // the server starts cleanly even when OIDC is not configured in dev.
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
  return async function verifyMemberToken(token: string): Promise<{ sub: string; tenantId: string; groups: string[] }> {
    if (!jwks) jwks = createRemoteJWKSet(new URL(cfg.jwksUri))
    const { payload } = await jwtVerify(token, jwks, {
      issuer: cfg.issuer,
      audience: cfg.audience,
    });
    // Claims are surfaced verbatim; the TENANT is deliberately NOT resolved here. The Host-resolved tenant
    // is the authority (it picks the RLS context and the FGA object ids), so app.ts keeps this `tenant`
    // claim only to REFUSE a token minted for somewhere else, then re-checks membership (#471 / ADR-176).
    // Putting the reconciliation in this verifier would hide that the Host, not the token, decides.
    return {
      sub: String(payload.sub),
      tenantId: String((payload as any).tenant ?? ""),
      groups: ((payload as any).groups as string[]) ?? [],
    };
  };
}

/** Best-effort discriminator so a single endpoint can accept both token kinds. */
export function looksLikeGuestToken(token: string): boolean {
  try {
    const [h] = token.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    return header?.typ === "guest+jwt";
  } catch {
    return false;
  }
}

export type { Principal };

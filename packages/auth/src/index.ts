// Token minting/verification for the two principal kinds.
// MEMBERS  -> OIDC (Authentik). Verified against the IdP JWKS.
// GUESTS   -> app-signed, short-lived share tokens. We mint AND verify these.
//
// Design (locked): guests are NEVER OIDC accounts. They never become tenant
// members and never count toward billing seats. Revocation is handled in the
// authz graph (delete the share_link tuple) + short token TTL + silent refresh.

import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import type { GuestTokenClaims, Principal, Capability, ResourceRef } from "@kb/types";

const enc = new TextEncoder();

export interface GuestTokenConfig {
  secret: string;
  ttlSeconds: number;
}

/** Mint a short-lived guest token bound to a single share link + resource. */
export async function mintGuestToken(
  cfg: GuestTokenConfig,
  args: { tenantId: string; shareLinkId: string; resource: ResourceRef; capability: Capability },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tenantId: args.tenantId,
    shareLinkId: args.shareLinkId,
    resource: args.resource,
    capability: args.capability,
  })
    .setProtectedHeader({ alg: "HS256", typ: "guest+jwt" })
    .setIssuedAt(now)
    .setExpirationTime(now + cfg.ttlSeconds)
    .sign(enc.encode(cfg.secret));
}

export async function verifyGuestToken(cfg: GuestTokenConfig, token: string): Promise<GuestTokenClaims> {
  const { payload } = await jwtVerify(token, enc.encode(cfg.secret), { typ: "guest+jwt" });
  // NOTE: structural validation only; capability is re-checked against OpenFGA
  // at the authorization boundary. The token asserts intent, not authority.
  return payload as unknown as GuestTokenClaims;
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
    // TODO(phase: auth): map IdP claims -> tenant + groups. Tenant may come from
    // the resolved request host rather than the token; reconcile here.
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

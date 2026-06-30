// User-macro package integrity / provenance (#98 / ADR-076) — the supply-chain security crux. A
// published macro version is signed; the platform verifies signature + content hash at install AND on
// every update, refuses tampered/unsigned/revoked packages, derives the trust tier from the SIGNING
// KEY (never the manifest's self-claim), and never silently auto-updates untrusted code. M1/M2 ship a
// signed first-party catalog only (community distribution off), so this is the verification core the
// install flow + runtime gate (#95 sandbox) build on. The crypto SCHEME (ed25519 / key custody) is an
// impl-time security-review choice, so it is INJECTED here — this module is the pure trust-chain logic.

export type TrustTier = "first-party" | "community";

// The immutable, signed manifest (ADR-076 §1). capabilities are all host-mediated (ADR-075 — no
// ambient authority); they are DISCLOSED, not granted, by the package.
export interface MacroManifest {
  readonly id: string;
  readonly version: string;
  readonly license: string;
  readonly capabilities: readonly string[];
  readonly contentHash: string; // hash of `content`, bound by the signature
}
export interface SignedPackage {
  readonly manifest: MacroManifest;
  readonly signatureKeyId: string; // which key signed it → the tier is DERIVED from this, not claimed
  readonly signature: string;
  readonly content: string;
}

export interface VerifyDeps {
  // Injected crypto (scheme = impl-time security review). Verifies `signature` over the content hash
  // under the key. Pure boolean — no ambient key lookup beyond the maps below.
  verifySignature: (keyId: string, signature: string, contentHash: string) => boolean;
  hashContent: (content: string) => string;
  trustedKeys: ReadonlyMap<string, TrustTier>; // platform key → first-party; author keys → community
  revokedKeys: ReadonlySet<string>;
  revokedVersions: ReadonlySet<string>; // entries are `${id}@${version}`
}

export type VerifyResult =
  | { ok: true; tier: TrustTier }
  | { ok: false; reason: "unsigned" | "untrusted_key" | "revoked" | "hash_mismatch" | "bad_signature" };

// Verify a package for install/update. Order matters: cheap/structural rejects first, the signature
// (the expensive crypto) last. The tier comes from the key map — a community package cannot claim
// first-party in its manifest because the manifest's tier is never consulted.
export function verifyPackage(pkg: SignedPackage, deps: VerifyDeps): VerifyResult {
  if (!pkg.signature || !pkg.signatureKeyId) return { ok: false, reason: "unsigned" };
  const tier = deps.trustedKeys.get(pkg.signatureKeyId);
  if (!tier) return { ok: false, reason: "untrusted_key" }; // unknown signer → refuse (no "trust the registry")
  if (deps.revokedKeys.has(pkg.signatureKeyId)) return { ok: false, reason: "revoked" }; // key kill-switch
  if (deps.revokedVersions.has(`${pkg.manifest.id}@${pkg.manifest.version}`)) return { ok: false, reason: "revoked" };
  if (deps.hashContent(pkg.content) !== pkg.manifest.contentHash) return { ok: false, reason: "hash_mismatch" }; // tamper
  if (!deps.verifySignature(pkg.signatureKeyId, pkg.signature, pkg.manifest.contentHash)) return { ok: false, reason: "bad_signature" };
  return { ok: true, tier };
}

// semver-ish compare (major.minor.patch) for downgrade detection. Missing/over-long parts → 0.
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// What changes when an installed macro is offered `candidate`. A new version is NEW untrusted code →
// it requires admin re-approval (no silent auto-update); any newly-requested capability is surfaced
// so a privilege increase can never slip in silently. Same version → idempotent (no re-approval).
export interface UpdateDecision {
  readonly needsReapproval: boolean;
  readonly addedCapabilities: readonly string[];
  readonly isDowngrade: boolean;
}
export function updateDecision(installed: MacroManifest, candidate: MacroManifest): UpdateDecision {
  const sameVersion = installed.version === candidate.version;
  const added = candidate.capabilities.filter((c) => !installed.capabilities.includes(c));
  return {
    needsReapproval: !sameVersion, // explicit re-approval on every version change (ADR-076 §2)
    addedCapabilities: added, // disclosed privilege increase — never silent
    isDowngrade: cmpVersion(candidate.version, installed.version) < 0,
  };
}

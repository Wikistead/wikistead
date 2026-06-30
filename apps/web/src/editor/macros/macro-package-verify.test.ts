// User-macro package verification (#98 / ADR-076) — the supply-chain trust chain. The attacks it
// must stop, asserted directly: unsigned / unknown-signer / tampered (hash mismatch) / bad signature
// / revoked (key or version) are refused; the tier comes from the SIGNING KEY (a community package
// can't claim first-party); and an update is never silent (new version → re-approval; added
// capabilities surfaced). Crypto is injected (the scheme is impl-time security review).
import { describe, it, expect } from "vitest";
import { verifyPackage, updateDecision, type SignedPackage, type VerifyDeps, type MacroManifest } from "./macro-package-verify";

const HASH = (c: string) => `h:${c}`; // deterministic fake content hash
const manifest = (over: Partial<MacroManifest> = {}): MacroManifest => ({
  id: "acme.chart", version: "1.0.0", license: "MIT", capabilities: ["theme"], contentHash: HASH("BODY"), ...over,
});
const pkg = (over: Partial<SignedPackage> = {}): SignedPackage => ({
  manifest: manifest(), signatureKeyId: "platform", signature: "sig", content: "BODY", ...over,
});
const deps = (over: Partial<VerifyDeps> = {}): VerifyDeps => ({
  verifySignature: () => true,
  hashContent: HASH,
  trustedKeys: new Map([["platform", "first-party"], ["alice", "community"]]),
  revokedKeys: new Set(),
  revokedVersions: new Set(),
  ...over,
});

describe("verifyPackage (#98 / ADR-076 supply-chain)", () => {
  it("accepts a well-signed package and derives the tier from the SIGNING KEY", () => {
    expect(verifyPackage(pkg(), deps())).toEqual({ ok: true, tier: "first-party" });
    expect(verifyPackage(pkg({ signatureKeyId: "alice" }), deps())).toEqual({ ok: true, tier: "community" });
  });

  it("a community package CANNOT claim first-party via its manifest (tier ignores the manifest)", () => {
    // manifest carries no tier field; even a forged one would be irrelevant — tier is the key's map value.
    const forged = pkg({ signatureKeyId: "alice", manifest: manifest({ id: "evil", capabilities: ["theme", "network"] }) });
    expect(verifyPackage(forged, deps())).toEqual({ ok: true, tier: "community" }); // alice → community, never first-party
  });

  it("refuses unsigned, unknown-signer, tampered, bad-signature", () => {
    expect(verifyPackage(pkg({ signature: "" }), deps())).toMatchObject({ ok: false, reason: "unsigned" });
    expect(verifyPackage(pkg({ signatureKeyId: "mallory" }), deps())).toMatchObject({ ok: false, reason: "untrusted_key" });
    expect(verifyPackage(pkg({ content: "TAMPERED" }), deps())).toMatchObject({ ok: false, reason: "hash_mismatch" });
    expect(verifyPackage(pkg(), deps({ verifySignature: () => false }))).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("refuses a revoked KEY and a revoked VERSION (central kill-switch)", () => {
    expect(verifyPackage(pkg(), deps({ revokedKeys: new Set(["platform"]) }))).toMatchObject({ ok: false, reason: "revoked" });
    expect(verifyPackage(pkg(), deps({ revokedVersions: new Set(["acme.chart@1.0.0"]) }))).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("checks the hash BEFORE the signature (a tamper is caught even if the signature stub would pass)", () => {
    let sigCalled = false;
    const r = verifyPackage(pkg({ content: "X" }), deps({ verifySignature: () => { sigCalled = true; return true; } }));
    expect(r).toMatchObject({ ok: false, reason: "hash_mismatch" });
    expect(sigCalled).toBe(false);
  });
});

describe("updateDecision (#98 — no silent auto-update of untrusted code)", () => {
  it("any new version requires admin re-approval; same version is idempotent (no re-approval)", () => {
    expect(updateDecision(manifest(), manifest({ version: "1.1.0" })).needsReapproval).toBe(true);
    expect(updateDecision(manifest(), manifest()).needsReapproval).toBe(false);
  });

  it("surfaces newly-requested capabilities — a privilege increase is never silent", () => {
    const d = updateDecision(manifest({ capabilities: ["theme"] }), manifest({ version: "2.0.0", capabilities: ["theme", "network"] }));
    expect(d.addedCapabilities).toEqual(["network"]);
    expect(d.needsReapproval).toBe(true);
  });

  it("flags a downgrade (pin protection)", () => {
    expect(updateDecision(manifest({ version: "2.0.0" }), manifest({ version: "1.0.0" })).isDowngrade).toBe(true);
    expect(updateDecision(manifest({ version: "1.0.0" }), manifest({ version: "1.2.0" })).isDowngrade).toBe(false);
  });
});

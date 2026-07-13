// #310 / ADR-136: the community registry submission check — validateMacroSubmission (schema / OSI license /
// sandbox-capability allowlist / size). Pure, so a plain unit test. The signature/byte-binding is verifyPackage's
// job (macro-package-verify.test); this covers the policy layer above it.
import { describe, it, expect } from "vitest";
import { validateMacroSubmission, OSI_LICENSES, ALLOWED_CAPABILITIES } from "./macro-registry";
import type { MacroManifest } from "./macro-package-verify";

const manifest = (over: Partial<MacroManifest> = {}): MacroManifest => ({
  id: "cool-macro", version: "1.2.3", license: "MIT", capabilities: ["theme"], contentHash: "h", ...over,
});
const meta = { name: "Cool Macro", description: "does cool things" };

describe("validateMacroSubmission (#310 / ADR-136)", () => {
  it("accepts a well-formed community submission (OSI license, sandbox capability, in-size)", () => {
    expect(validateMacroSubmission(manifest(), meta, "export default {}")).toEqual({ ok: true });
  });

  it("rejects a non-OSI / bespoke license (community tier requires OSI,)", () => {
    const r = validateMacroSubmission(manifest({ license: "LicenseRef-proprietary" }), meta, "x");
    expect(r.ok).toBe(false);
    expect((r as { errors: string[] }).errors.join(" ")).toMatch(/OSI-approved/);
  });

  it("accepts a NON-permissive OSI license (GPL/AGPL) — arms-length channel, not our bundle", () => {
    expect(validateMacroSubmission(manifest({ license: "AGPL-3.0-or-later" }), meta, "x")).toEqual({ ok: true });
    expect(OSI_LICENSES.has("GPL-3.0-only")).toBe(true);
  });

  it("rejects a capability outside the sandbox surface (ADR-075)", () => {
    const r = validateMacroSubmission(manifest({ capabilities: ["theme", "fs.write"] }), meta, "x");
    expect(r.ok).toBe(false);
    expect((r as { errors: string[] }).errors.join(" ")).toMatch(/outside the sandbox/);
    expect(ALLOWED_CAPABILITIES.has("fs.write")).toBe(false);
  });

  it("rejects a bad id / non-semver version", () => {
    expect(validateMacroSubmission(manifest({ id: "Bad_Id" }), meta, "x").ok).toBe(false);
    expect(validateMacroSubmission(manifest({ version: "1.2" }), meta, "x").ok).toBe(false);
  });

  it("rejects oversize content (byte length, not char length)", () => {
    const big = "a".repeat(300 * 1024);
    const r = validateMacroSubmission(manifest(), meta, big);
    expect(r.ok).toBe(false);
    expect((r as { errors: string[] }).errors.join(" ")).toMatch(/over the/);
  });

  it("rejects a non-http(s) homepage (javascript:/data: → stored-XSS in the site link)", () => {
    expect(validateMacroSubmission(manifest(), { ...meta, homepage: "javascript:alert(1)" }, "x").ok).toBe(false);
    expect(validateMacroSubmission(manifest(), { ...meta, homepage: "data:text/html,x" }, "x").ok).toBe(false);
    expect(validateMacroSubmission(manifest(), { ...meta, homepage: "https://ok.example/m" }, "x")).toEqual({ ok: true });
  });

  it("requires discovery name + description and collects ALL errors in one pass", () => {
    const r = validateMacroSubmission(manifest({ id: "X", version: "v1", license: "nope" }), { name: "", description: "" }, "x");
    expect(r.ok).toBe(false);
    // id + version + license + name + description = 5 distinct errors.
    expect((r as { errors: string[] }).errors.length).toBeGreaterThanOrEqual(5);
  });
});

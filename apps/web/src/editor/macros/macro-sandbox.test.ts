// @vitest-environment happy-dom
// User-macro sandbox isolation primitives (#95 / ADR-075). The attacks these MUST stop, asserted
// directly: allow-same-origin is never set; the sandbox refuses the app origin; a postMessage is
// trusted ONLY from the exact sandbox origin AND our exact frame window (not the app, a sibling
// macro, a null/opaque origin, or a wildcard).
import { describe, it, expect } from "vitest";
import { MACRO_SANDBOX_FLAGS, macroSandboxOrigin, createMacroSandboxFrame, isTrustedFrameMessage } from "./macro-sandbox";

const APP = "https://app.example.com";
const SANDBOX = "https://abc.usercontent.example.com";

describe("MACRO_SANDBOX_FLAGS (#95 / ADR-075 isolation keystone)", () => {
  it("grants allow-scripts but NEVER allow-same-origin (that would defeat isolation)", () => {
    const flags = MACRO_SANDBOX_FLAGS.split(/\s+/);
    expect(flags).toContain("allow-scripts");
    expect(flags).not.toContain("allow-same-origin");
    expect(flags).not.toContain("allow-top-navigation");
    expect(flags).not.toContain("allow-popups");
  });
});

describe("macroSandboxOrigin (operator opt-in; fail-safe)", () => {
  it("is null (sandbox disabled) when unconfigured — the M1/M2 first-party-only default", () => {
    expect(macroSandboxOrigin(APP, undefined)).toBeNull();
    expect(macroSandboxOrigin(APP, null)).toBeNull();
    expect(macroSandboxOrigin(APP, "")).toBeNull();
  });
  it("is null for an invalid config and for the APP origin (never run macros on the app origin)", () => {
    expect(macroSandboxOrigin(APP, "not a url")).toBeNull();
    expect(macroSandboxOrigin(APP, APP)).toBeNull(); // same origin defeats isolation
  });
  it("returns the separate origin when validly configured", () => {
    expect(macroSandboxOrigin(APP, SANDBOX + "/macro-frame")).toBe(SANDBOX);
  });
});

describe("createMacroSandboxFrame", () => {
  it("builds a cross-origin iframe with allow-scripts and NO allow-same-origin", () => {
    const frame = createMacroSandboxFrame(document, SANDBOX, APP)!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.src.startsWith(SANDBOX + "/")).toBe(true); // separate origin
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
  it("refuses (null) to build a frame on the app origin or with an empty origin", () => {
    expect(createMacroSandboxFrame(document, APP, APP)).toBeNull();
    expect(createMacroSandboxFrame(document, "", APP)).toBeNull();
  });
});

describe("isTrustedFrameMessage (bidirectional origin + source check)", () => {
  const frameWin = { id: "ourFrame" };
  const expected = { origin: SANDBOX, frameWindow: frameWin };

  it("accepts ONLY the exact sandbox origin from OUR frame window", () => {
    expect(isTrustedFrameMessage({ origin: SANDBOX, source: frameWin }, expected)).toBe(true);
  });
  it("rejects the app origin, a different origin, a null/opaque origin", () => {
    expect(isTrustedFrameMessage({ origin: APP, source: frameWin }, expected)).toBe(false);
    expect(isTrustedFrameMessage({ origin: "https://evil.example.com", source: frameWin }, expected)).toBe(false);
    expect(isTrustedFrameMessage({ origin: "null", source: frameWin }, expected)).toBe(false);
  });
  it("rejects a message from a DIFFERENT window even on the right origin (sibling macro / opener)", () => {
    expect(isTrustedFrameMessage({ origin: SANDBOX, source: { id: "otherFrame" } }, expected)).toBe(false);
  });
  it("never trusts a wildcard or empty expected origin (misconfiguration is fail-closed)", () => {
    expect(isTrustedFrameMessage({ origin: SANDBOX, source: frameWin }, { origin: "*", frameWindow: frameWin })).toBe(false);
    expect(isTrustedFrameMessage({ origin: SANDBOX, source: frameWin }, { origin: "", frameWindow: frameWin })).toBe(false);
  });
});

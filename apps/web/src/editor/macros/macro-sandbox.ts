// User-macro sandbox isolation primitives (#95 / ADR-075 — ADR-023 Stage 2). Untrusted user-macro
// render code runs in a CROSS-ORIGIN sandboxed iframe so it can never reach the app's cookies /
// session token / same-origin DOM / storage. M1/M2 ship FIRST-PARTY macros only, so this is DORMANT
// until (a) an operator configures a user-content origin AND (b) user macros exist (#98 marketplace);
// it is the security keystone those build on. The two inviolable, attack-tested rules:
//   1. the iframe is sandboxed WITHOUT `allow-same-origin` and points at a SEPARATE origin —
//      `allow-same-origin` would defeat the entire isolation, so it is NEVER set, and the sandbox
//      refuses to run on the app origin.
//   2. the postMessage channel validates BOTH the sender origin AND the source window — a message
//      from any other origin/window (the app, a sibling macro, an attacker frame) is rejected; a
//      wildcard / null origin is never trusted.

// allow-scripts ONLY. Deliberately omits allow-same-origin (isolation keystone), allow-top-navigation,
// allow-popups, allow-forms, allow-modals — a macro renders into itself and talks only via postMessage.
export const MACRO_SANDBOX_FLAGS = "allow-scripts";

// Resolve the operator-configured user-content origin (opt-in). Returns null — the sandbox DISABLED,
// no user macros run — when unconfigured (the M1/M2 default), when the value is not a valid URL, or
// when it resolves to the APP origin (which would defeat isolation). Fail-safe: any doubt → null.
export function macroSandboxOrigin(appOrigin: string, configured: string | undefined | null): string | null {
  if (!configured) return null; // not configured → dormant (first-party only)
  let origin: string;
  try {
    origin = new URL(configured).origin;
  } catch {
    return null; // invalid config → dormant, never guess
  }
  if (origin === appOrigin) return null; // SAME origin would defeat isolation → refuse
  return origin;
}

// Build the cross-origin sandboxed iframe for a macro render document. Returns null (caller does NOT
// run the macro) when the origin is unusable — empty or equal to the app origin — so a
// misconfiguration can never silently run untrusted code on the app origin.
export function createMacroSandboxFrame(doc: Document, sandboxOrigin: string, appOrigin: string): HTMLIFrameElement | null {
  if (!sandboxOrigin || sandboxOrigin === appOrigin) return null; // isolation guard
  const frame = doc.createElement("iframe");
  frame.setAttribute("sandbox", MACRO_SANDBOX_FLAGS); // allow-scripts only — NO allow-same-origin
  frame.setAttribute("referrerpolicy", "no-referrer"); // don't leak the app URL to the macro origin
  frame.className = "wks-macro-sandbox";
  frame.src = `${sandboxOrigin}/macro-frame`; // the user-content render document on the separate origin
  return frame;
}

// Bidirectional postMessage validation. Accept ONLY a message whose origin is EXACTLY the sandbox
// origin AND whose source is EXACTLY our frame's window. This rejects the app origin, a null/opaque
// origin, a wildcard, any sibling/opener frame, and an origin/source mismatch (confused-deputy /
// rebinding). The host must call this before acting on ANY message from the macro.
export function isTrustedFrameMessage(
  ev: { origin: string; source: unknown },
  expected: { origin: string; frameWindow: unknown },
): boolean {
  if (!expected.origin || expected.origin === "null" || expected.origin === "*") return false; // never wildcard/null
  if (ev.origin !== expected.origin) return false; // must come from the sandbox origin, not the app/attacker
  if (ev.source !== expected.frameWindow) return false; // must be OUR frame, not a sibling macro / opener
  return true;
}

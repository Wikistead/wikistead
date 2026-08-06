// #666②: the passkey endpoints had no caller.
//
// `@simplewebauthn/browser` was imported for `startAuthentication` alone, so the panel could give a key
// UP and never take one ON — the security tab offered one button, "add an authenticator app". A member
// could not reach the removal this ticket fixed, because they could not have a passkey in the first
// place. The browser spec measures the whole loop; this is the cheap guard that the CALLER exists,
// because "a shipped endpoint nobody calls" is a state the source can be asked about directly and the
// state this file exists to keep from coming back.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const panel = readFileSync(resolve(import.meta.dirname, "SecondFactorPanel.tsx"), "utf8");
const code = panel.split("\n").map((l) => l.replace(/^\s*(?:\/\/|\*|\/\*|\{\/\*).*$/, "")).join("\n");

describe("#666: a passkey can be added from the panel", () => {
  it("calls the registration ceremony, not only the authentication one", () => {
    expect(/\bstartRegistration\b/.test(code), "the browser is asked to CREATE a credential").toBe(true);
    expect(/\bstartAuthentication\b/.test(code), "…and the removal still signs with it").toBe(true);
  });

  it("has a control that starts it", () => {
    expect(/data-testid="factor-add-passkey"/.test(code), "there is a button for a key").toBe(true);
    expect(/data-testid="factor-add"/.test(code), "…beside the one for an authenticator app").toBe(true);
  });

  it("finishes the enrolment against the server", () => {
    // `startRegistration` alone leaves a pending row and a credential nothing was told about: the key
    // exists on the device, the factor is unconfirmed, and the member is one slot poorer with nothing
    // to show. The second call is what makes it a factor.
    expect(/useConfirmPasskey|factors\/[^\n]*\/passkey/.test(code), "the attestation goes back").toBe(true);
  });
});

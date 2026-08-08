// #568 / ADR-198 §3: password sign-in on the login screen.
//
// A password connection is a CONNECTION, so it arrives through the same ordered list as every other
// way in — but it is not a button, because there is nowhere to redirect to. The two things worth
// pinning are that it never lands in the button lists (a "Sign in" button that goes nowhere is worse
// than no button) and that its failure copy stays ONE message: the screen is the easiest place in
// the product to ask "does this account exist" a thousand times, and the API withholds that answer.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connectionsFor, connectionButtonText } from "./LoginScreen";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";
import { isServerFault } from "./serverFault";

const src = (f: string) => readFileSync(resolve(import.meta.dirname, f), "utf8");
const t = (k: string) => k;

describe("#568: the password form is not a button", () => {
  it("the screen splits `local` out of the button lists", () => {
    const s = src("./LoginScreen.tsx");
    expect(s).toContain('c.kind !== "local"');
    expect(s).toContain('conns.findIndex((c) => c.kind === "local")');
  });

  it("its position in the tenant's order still decides whether it leads or follows", () => {
    // Ordering IS the login screen's order for every other method; a form that always sat at the
    // bottom would quietly ignore the admin's arrangement.
    const s = src("./LoginScreen.tsx");
    expect(s).toContain("localLeads");
    expect(s).toContain("hasLocal && !localLeads");
  });

  it("the no-methods message does not appear when the only way in is the form", () => {
    const s = src("./LoginScreen.tsx");
    expect(s).toContain("primary === null && !hasLocal");
  });

  it("a local connection never reaches the button-text helper as a redirect", () => {
    // connectionsFor is the degradation path (no server list); it must not synthesise a local
    // connection out of the legacy `methods` array, which has no way to express one.
    expect(connectionsFor(undefined, ["oidc", "saml", "local"]).some((c) => c.kind === "local")).toBe(false);
    // and the helper still answers for the kinds that ARE buttons
    expect(connectionButtonText({ id: "", kind: "saml", label: null, brand: null }, t)).toBe("auth.signInSaml");
  });

  it("the form sends credentials with the cookie kept, and posts to the login route", () => {
    const s = src("./LocalLoginForm.tsx");
    expect(s).toContain('assetUrl("/auth/local/login")');
    // the response SETS the session cookie; omitting credentials would sign nobody in
    expect(s).toContain('credentials: "include"');
  });

  it("every failure ABOUT THE READER reads the same — the screen is not an enumeration oracle", () => {
    // One sentence for whatever the server answered about this person: 401, 403, 404 and 429 must not
    // be distinguishable, or the screen tells an attacker which addresses exist.
    //
    // ⚠️ #681 added ONE split, and it is not that one. A 5xx is not an answer about the reader at all —
    // it is the server failing — and collapsing it into "that email and password do not work" sent
    // every reader to the password-reset flow during an outage while the operator saw no errors. The
    // rule is therefore stated as a MAPPING and measured, rather than as a ban on reading the status:
    // the four reader-facing codes still land on one message.
    const reader = [401, 403, 404, 429].map((status) => isServerFault({ status } as Response))
    expect(new Set(reader).size, "two reader-facing statuses read differently").toBe(1)
    expect(reader[0], "a refusal about the reader must not read as an outage").toBe(false)
    // …and the outage really is separated, or #681 is back
    expect(isServerFault({ status: 500 } as Response)).toBe(true)
    expect(isServerFault(null), "a request that never completed is not about the reader either").toBe(true)

    const s = src("./LocalLoginForm.tsx")
    // the credential sentence is still the one a reader-facing refusal reaches
    expect(s).toContain('"credentials"')
    // the only other state that is NOT the server's answer is client-side and named as such
    expect(s).toContain('setFailed("needsAddress")')
    for (const loc of [en, ja] as Array<{ auth: Record<string, string> }>) {
      for (const k of ["localIdentifier", "localPassword", "localFailed", "resetNeedsAddress", "forgotPassword", "resetSent", "temporarilyUnavailable"]) {
        expect(loc.auth[k], k).toBeTruthy()
      }
    }
  });
});

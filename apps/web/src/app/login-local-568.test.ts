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

  it("every SERVER failure reads the same — the screen must not become the enumeration oracle", () => {
    const s = src("./LocalLoginForm.tsx");
    // One message for whatever the server answered, chosen without reading the status: 401, 403 and
    // 429 are one sentence. (A second message exists for "you have not typed an address yet", which
    // the form knows on its own and never asks the server about — review F4. That one cannot leak
    // anything, because no request was made.)
    expect(s).toContain('setFailed("credentials")');
    expect(s).not.toMatch(/status === 401|status === 404|res\.status ===/);
    // the only other state is client-side and named as such
    expect(s).toContain('setFailed("needsAddress")');
    for (const loc of [en, ja] as Array<{ auth: Record<string, string> }>) {
      for (const k of ["localIdentifier", "localPassword", "localFailed", "resetNeedsAddress", "forgotPassword", "resetSent"]) {
        expect(loc.auth[k], k).toBeTruthy();
      }
    }
  });
});
